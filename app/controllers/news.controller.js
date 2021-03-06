const constants = require('../../config/constants');
const redisClient = require('../../config/redis')(1);
const globalClient = require('../../config/redis')(3);
const redisUtil = require('../utils/redis.util');
const Model = require('../models/index');
const HttpSend = require('../utils/http.util');
const moment = require('moment');
const config = require('../../config/config');
const globalController = require('./global.controller');
const logger = require('../utils/log.util').getLogger(constants.LOGGER_LEVEL);

const Op = Model.Sequelize.Op;

// 根据资讯id  查询点赞总数、浏览总数、评论总数
exports.getPVAndThumpById = async (newsId) => {
  const thumbUpKey = redisUtil.getRedisPrefix(1);
  const pvKey = redisUtil.getRedisPrefix(2);
  const commentKey = redisUtil.getRedisPrefix(13);
  const [pvNum, thumbUpNum, commentNum] = await Promise.all([
    redisClient.zscoreAsync(pvKey, newsId),
    redisClient.zscoreAsync(thumbUpKey, newsId),
    redisClient.zscoreAsync(commentKey, newsId),
  ]);

  return {
    pvNum: Math.round(pvNum) || 0,
    thumbUpNum: thumbUpNum || 0,
    commentNum: commentNum || 0,
  };
};

const getNewsList = async (orderType, contextType, page) => {
  // 分页中每页的最大数量
  const limit = 15;

  // 按照发布时间最新查找资讯
  const findByNew = async () => {
    const conditions = {
      order: [['newsId', 'DESC']],
      offset: limit * (page - 1),
      limit,
    };
    if (contextType !== constants.CONTEXT_TOTAL) {
      conditions.where = { newsClass: contextType };
    }
    return Model.News.findAndCountAll(conditions);
  };

  // 按照热门程度查找资讯  热门目前按照总浏览量排序
  const findByHot = async () => {
    const rankKey = contextType === constants.CONTEXT_TOTAL ?
      redisUtil.getRedisPrefix(2) :
      redisUtil.getRedisPrefix(2, contextType);
    const [start, end] = [(page - 1) * limit, page * limit];
    const rankList = await redisClient.zrevrangeAsync(rankKey, start, end);
    const count = await redisClient.zcardAsync(rankKey);

    let newsInfos = {
      rows: [],
      count,
    };
    if (rankList.length) {
      // 这种写法等于Op.in:(1,2,3,4)
      const datas = await Model.News.findAll({ where: { newsId: rankList } });
      // 按照排行榜的顺序重新排序
      for (const newsId of rankList) {
        for (const data of datas) {
          if (data.dataValues && parseInt(data.dataValues.newsId, 0) === parseInt(newsId, 0)) {
            newsInfos.rows.push({ dataValues: data.dataValues });
            break;
          }
        }
      }
    } else {
      newsInfos = await findByNew();
    }

    return newsInfos;
  };

  const mainFunction = async () => {
    try {
      let newsInfos = [];
      const newLists = [];
      if (orderType === constants.HOT_NEWS) {
        newsInfos = await findByHot();
      } else {
        newsInfos = await findByNew();
      }

      // 并发查询每个资讯的点赞数和访问数
      const getNewsPromises = newsInfos.rows.map(async (newsInfo) => {
        const newsId = newsInfo.dataValues.newsId || 0;
        const supportInfo = await exports.getPVAndThumpById(newsId);
        let redirectUrl = '/news/details';
        if (parseInt(newsInfo.dataValues.type, 0) === constants.TYPE_ESTIMATE) {
          redirectUrl = '/news/tests';
        }
        return {
          newsId,
          redirectUrl: `${redirectUrl}/${newsId}`,
          newsClass: newsInfo.dataValues.newsClass,
          title: newsInfo.dataValues.title,
          introduction: newsInfo.dataValues.introduction,
          imgUrl: newsInfo.dataValues.imgUrl,
          createdAt: newsInfo.dataValues.createdAt,
          pv: supportInfo.pvNum,
          thumbUp: supportInfo.thumbUpNum,
          commentNum: supportInfo.commentNum,
        };
      });

      // 将并发的结果按照之前的顺序保存
      for (const newsPromise of getNewsPromises) {
        const info = await newsPromise;
        newLists.push(info);
      }
      return { newLists, totalPage: Math.ceil(newsInfos.count / limit) };
    } catch (error) {
      logger.info(error);
      throw error;
    }
  };

  return mainFunction();
};

// 资讯首页
exports.index = (req, res, next) => {
  // 资讯查找方式  按热门/按最新
  const orderType = parseInt(req.query.order, 0) || constants.HOT_NEWS;
  // 资讯内容分类  按领域分类/全部
  const contextType = parseInt(req.query.context, 0) || constants.CONTEXT_TOTAL;
  // 分页
  const page = req.query.page || 1;
  const httpUtil = new HttpSend(req, res);

  const mainFunction = async () => {
    try {
      const rtn = await getNewsList(orderType, contextType, page);

      const newsClass = constants.NEWS_CLASS_LIST;
      httpUtil.render('news/news', {
        title: '热文资讯', newLists: rtn.newLists, totalPage: rtn.totalPage, newsClass, contextType,
      });
    } catch (err) {
      next(err);
    }
  };
  mainFunction();
};

// 资讯首页
exports.getNewsListByCondition = (req, res) => {
  // 资讯查找方式  按热门/按最新
  const orderType = parseInt(req.query.order, 0) || constants.HOT_NEWS;
  // 资讯内容分类  按领域分类/全部
  const contextType = parseInt(req.query.context, 0) || constants.CONTEXT_TOTAL;
  // 分页
  const page = req.query.page || 1;
  const resUtil = new HttpSend(req, res);

  const mainFunction = async () => {
    try {
      const rtn = await getNewsList(orderType, contextType, page);
      resUtil.sendJson(constants.HTTP_SUCCESS, '', { newLists: rtn.newLists, totalPage: rtn.totalPage });
    } catch (err) {
      logger.info(err);
      resUtil.sendJson(constants.HTTP_FAIL, '系统错误');
    }
  };
  mainFunction();
};

// 根据资讯id  增加对应的浏览日志
exports.addViewLogByNewsId = async (newsInfo, viewerInfo, shareUserId) => {
  // 如果有分享者，先查询分享者信息
  const shareInfo = {
    shareId: shareUserId,
    shareName: '',
    sharePhone: '',
  };
  if (shareInfo.shareId) {
    if (shareInfo.shareId === viewerInfo.userId) {
      shareInfo.shareName = viewerInfo.userName;
      shareInfo.shareHeadImg = viewerInfo.headImgUrl;
    } else {
      const data = await Model.User.findOne({ where: { userId: shareInfo.shareId } });
      if (!data || !data.dataValues) {
        shareInfo.shareId = '';
      } else {
        shareInfo.shareName = data.dataValues.userName;
        shareInfo.shareHeadImg = data.dataValues.headImgUrl;
      }
    }
  }

  // 查询操作对应的积分数量
  const operateType = shareInfo.shareId && shareInfo.shareId !== viewerInfo.userId ? 2 : 1;
  const pointInfo = await Model.BonusPoint.findOne({ where: { id: operateType } });
  const pointNum = pointInfo && pointInfo.dataValues ? pointInfo.dataValues.pointNum : 0;
  const otherPointNum = pointInfo && pointInfo.dataValues ? pointInfo.dataValues.otherPointNum : 0;

  // 浏览者和分享者（如果有）的最新积分，非负数时有效，更新至积分商城
  let viewerNewTotalPoint = -1;
  let shareNewTotalPoint = -1;
  Model.sequelize.transaction(async (transaction) => {
    /** *****************************记录资讯浏览日志**************************************** */
    const pvNewsInfo = await Model.PVNews.create({
      newsId: newsInfo.newsId,
      writerName: newsInfo.writerName,
      newsClass: newsInfo.newsClass,
      title: newsInfo.title,
      introduction: newsInfo.introduction,
      viewerId: viewerInfo.userId,
      viewerName: viewerInfo.userName,
      viewerHeadImg: viewerInfo.headImgUrl,
      shareId: shareInfo.shareId || null,
      shareName: shareInfo.shareName,
      shareHeadImg: shareInfo.shareHeadImg,
    }, { transaction });

    /** ************************************更新浏览记录相关redis数据************************************* */
    const today = moment().format('YYYYMMDD');
    // 所有文章 浏览总榜（决定热门显示顺序）
    const pvTotalKey = redisUtil.getRedisPrefix(2);
    // 所有文章 分类浏览总榜（决定热门显示顺序）
    const pvContextKey = redisUtil.getRedisPrefix(2, newsInfo.newsClass);

    // 某文章当日所有浏览人 记录（日志记录）
    const newsUvKey = redisUtil.getRedisPrefix(5, `${shareInfo.shareId}:${today}`);

    // 指定文章所有浏览人记录（积分统计时使用，仅在第一次浏览加积分）
    const pvNewsLogKey = redisUtil.getRedisPrefix(15, newsInfo.newsId);
    // 用户分享某文章后的浏览人记录(积分统计时使用，仅在分享后第一次浏览加积分）
    const pvUserNewsLogKey = redisUtil.getRedisPrefix(16, `${newsInfo.newsId}:${shareInfo.shareId}`);

    // 该分享人的热门文章当日排行 (饼状图排行榜使用)
    const shareUserTypeKey = redisUtil.getRedisPrefix(4, `${shareInfo.shareId}:${today}`);
    const shareUserKey = redisUtil.getRedisPrefix(3, `${shareInfo.shareId}:${today}`);

    // 鉴于multi并不会产生回滚，所以一旦exec出错  还是有错误数据会+1
    let updateRedis = [];
    let userPvNum = 0;
    let userNewPVNum = 0;
    if (shareInfo.shareId) {
      updateRedis = await redisClient.multi()
        .zincrby(pvTotalKey, 1, newsInfo.newsId)
        .zincrby(pvContextKey, 1, newsInfo.newsId)
        .hincrby(pvNewsLogKey, viewerInfo.userId, 1)
        .hincrby(pvUserNewsLogKey, viewerInfo.userId, 1)
        .hincrby(newsUvKey, viewerInfo.userId, 1)
        .zincrby(shareUserTypeKey, 1, newsInfo.newsClass)
        .zincrby(`${shareUserKey}:all`, 1, newsInfo.newsId)
        // .zincrby(`${shareUserKey}:${newsInfo.newsClass}`, 1, newsInfo.newsId) 目前前端根据标签自己排序
        .execAsync();
      userPvNum = parseInt(updateRedis[2], 0);
      userNewPVNum = parseInt(updateRedis[3], 0);
    } else {
      updateRedis = await redisClient.multi()
        .zincrby(pvTotalKey, 1, newsInfo.newsId)
        .zincrby(pvContextKey, 1, newsInfo.newsId)
        .hincrby(pvNewsLogKey, viewerInfo.userId, 1)
        .execAsync();
      userPvNum = parseInt(updateRedis[2], 0);
    }

    /** *****************************如果第一次浏览该新闻，增加浏览者积分日志************************************* */
    if (userPvNum === 1 && pointNum > 0) {
      const bonusKey = redisUtil.getRedisPrefix(18);
      const totalPoint = await globalClient.hincrbyAsync(bonusKey, viewerInfo.userId, pointNum);
      await Model.PointRecord.create({
        viewerId: viewerInfo.userId,
        shareId: shareInfo.shareId || null,
        operator: 1,
        changeNum: pointNum,
        totalPoint,
        newsId: newsInfo.newsId,
        proofId: pvNewsInfo.dataValues.id,
      }, { transaction });
      viewerNewTotalPoint = totalPoint;
    }

    /** ******************如果有分享者(且非自己)，且被分享人第一次点入该链接，增加分享者积分日志******************** */
    if (shareInfo.shareId && shareUserId !== viewerInfo.userId &&
      userNewPVNum === 1 && otherPointNum > 0
    ) {
      const key = redisUtil.getRedisPrefix(18);
      const totalPoint = await globalClient.hincrbyAsync(key, shareInfo.shareId, otherPointNum);
      await Model.PointRecord.create({
        viewerId: shareInfo.shareId,
        shareId: viewerInfo.userId,
        operator: 2,
        changeNum: otherPointNum,
        totalPoint,
        newsId: newsInfo.newsId,
        proofId: pvNewsInfo.dataValues.id,
      }, { transaction });
      shareNewTotalPoint = totalPoint;
    }
  }).then(() => {
    if (viewerNewTotalPoint >= 0) {
      globalController.addGlobalPoint(viewerInfo.userId, viewerNewTotalPoint);
    }
    if (shareNewTotalPoint >= 0) {
      globalController.addGlobalPoint(shareUserId, shareNewTotalPoint);
    }
  }).catch((err) => {
    // Rolled back
    logger.info(err);
  });
};

// 资讯详情页
exports.getNewsDetailById = (req, res, next) => {
  const newsId = parseInt(req.params.newsId, 0) || 0;
  // 分享者id
  const shareId = req.query.shareId || '';
  const userId = req.session.user.userId || '';
  const httpUtil = new HttpSend(req, res);

  if (!newsId || !userId) {
    const error = new Error('参数错误');
    next(error);
    return;
  }

  const mainFunction = async () => {
    try {
      // 查询文章
      const newsInfo = await Model.News.findOne({ where: { newsId } });

      if (!newsInfo || !newsInfo.dataValues) {
        throw new Error('该资讯不存在');
      }

      if (newsInfo.dataValues.type !== constants.TYPE_NEWS) {
        throw new Error('资讯类型错误');
      }

      // 查询是否已经点过赞
      const thumbUpKey = redisUtil.getRedisPrefix(17, newsId);
      const ifThumb = await redisClient.hgetAsync(thumbUpKey, userId);

      // 查询点赞总数、浏览总数、评论总数
      const supportInfo = await exports.getPVAndThumpById(newsId);

      // 查询评论列表
      const commentListKey = redisUtil.getRedisPrefix(14, newsId);
      const commentInfos = await redisClient.lrangeAsync(commentListKey, 0, -1);
      const commentLength = commentInfos.length;
      const commentList = [];
      for (let i = (commentLength - 1); i >= 0; i -= 1) {
        commentList.push(JSON.parse(commentInfos[i]));
      }

      const pageInfo = {
        newsId: newsInfo.dataValues.newsId,
        userName: newsInfo.dataValues.writerName,
        newsClass: newsInfo.dataValues.newsClass,
        title: newsInfo.dataValues.title,
        introduction: newsInfo.dataValues.introduction,
        context: newsInfo.dataValues.context,
        imgUrl: newsInfo.dataValues.imgUrl,
        createdAt: newsInfo.dataValues.createdAt,
        pv: parseInt(supportInfo.pvNum, 0) + 1,
        thumbUp: supportInfo.thumbUpNum,
        commentNum: supportInfo.commentNum,
        commentList,
        ifThumb: ifThumb > 0,
      };


      exports.addViewLogByNewsId(newsInfo.dataValues, req.session.user, shareId);
      const shareUid = shareId || userId;
      const shareLink = encodeURI(`${config.serverHost}/news/details/${pageInfo.newsId}?shareId=${shareUid}`);
      const renderUrl = !shareId ? 'news/news-detail' : 'news/news-detail-share';
      httpUtil.render(renderUrl, {
        title: '热文资讯', pageInfo, shareLink, shareUid: shareId,
      });
    } catch (err) {
      logger.info(err);
      next(err);
    }
  };

  mainFunction();
};

// 根据资讯id  增加对应的转发日志
exports.addTransmitLogByNewsId = async (newsInfo, viewerInfo, shareUserId) => {
  // 如果有分享者，先查询分享者信息
  const shareInfo = {
    shareId: shareUserId,
    shareName: '',
    sharePhone: '',
  };

  if (shareInfo.shareId) {
    if (shareInfo.shareId === viewerInfo.userId) {
      shareInfo.shareName = viewerInfo.userName;
      shareInfo.shareHeadImg = viewerInfo.headImgUrl;
    } else {
      const data = await Model.User.findOne({ where: { userId: shareInfo.shareId } });
      if (!data || !data.dataValues) {
        shareInfo.shareId = '';
      } else {
        shareInfo.shareName = data.dataValues.userName;
        shareInfo.shareHeadImg = data.dataValues.headImgUrl;
      }
    }
  }

  // 查询操作对应的积分数量
  const operateType = shareInfo.shareId && shareInfo.shareId !== viewerInfo.userId ? 4 : 3;
  const pointInfo = await Model.BonusPoint.findOne({ where: { id: operateType } });
  const pointNum = pointInfo && pointInfo.dataValues ? pointInfo.dataValues.pointNum : 0;
  const otherPointNum = pointInfo && pointInfo.dataValues ? pointInfo.dataValues.otherPointNum : 0;

  // 分享者（如果有）和浏览者的最新总积分，>=0时更新
  let viewerNewTotalPoint = -1;
  let shareNewTotalPoint = -1;
  Model.sequelize.transaction(async (transaction) => {
    /** *****************************记录资讯转发日志**************************************** */
    const transmitInfo = await Model.TransmitNews.create({
      newsId: newsInfo.newsId,
      writerName: newsInfo.writerName,
      newsClass: newsInfo.newsClass,
      title: newsInfo.title,
      introduction: newsInfo.introduction,
      viewerId: viewerInfo.userId,
      viewerName: viewerInfo.userName,
      viewerHeadImg: viewerInfo.headImgUrl,
      shareId: shareInfo.shareId,
      shareName: shareInfo.shareName,
      shareHeadImg: shareInfo.shareHeadImg,
    }, { transaction });

    /** ************************************更新转发记录相关redis数据************************************* */
    // 指定文章所有转发人记录
    const transmitNewsLogKey = redisUtil.getRedisPrefix(21, newsInfo.newsId);
    // 下级的二次转发记录
    const transmitUserNewsLogKey = redisUtil.getRedisPrefix(22, `${newsInfo.newsId}:${shareInfo.shareId}`);

    let updateRedis = [];
    let userTransmitNum = 0;
    let userNewTransmitNum = 0;
    if (shareInfo.shareId) {
      updateRedis = await redisClient.multi()
        .hincrby(transmitNewsLogKey, viewerInfo.userId, 1)
        .hincrby(transmitUserNewsLogKey, viewerInfo.userId, 1)
        .execAsync();
      userTransmitNum = parseInt(updateRedis[0], 0);
      userNewTransmitNum = parseInt(updateRedis[1], 0);
    } else {
      updateRedis = await redisClient.multi()
        .hincrby(transmitNewsLogKey, viewerInfo.userId, 1)
        .execAsync();
      userTransmitNum = parseInt(updateRedis[0], 0);
    }

    /** *****************************如果第一次转发该文章，增加该转发者积分日志************************************* */
    if (userTransmitNum === 1 && pointNum > 0) {
      const bonusKey = redisUtil.getRedisPrefix(18);
      const totalPoint = await globalClient.hincrbyAsync(bonusKey, viewerInfo.userId, pointNum);
      await Model.PointRecord.create({
        viewerId: viewerInfo.userId,
        shareId: shareInfo.shareId,
        operator: 3,
        changeNum: pointNum,
        totalPoint,
        newsId: newsInfo.newsId,
        proofId: transmitInfo.dataValues.id,
      }, { transaction });
      viewerNewTotalPoint = totalPoint;
    }

    /** ****************如果有分享者(且不为本人)，且被分享人第一次转发该链接，增加分享者积分日志****************** */
    if (shareInfo.shareId && shareUserId !== viewerInfo.userId &&
      userNewTransmitNum === 1 && otherPointNum > 0
    ) {
      const key = redisUtil.getRedisPrefix(18);
      const totalPoint = await globalClient.hincrbyAsync(key, shareInfo.shareId, otherPointNum);
      await Model.PointRecord.create({
        viewerId: shareInfo.shareId,
        shareId: viewerInfo.userId,
        operator: 4,
        changeNum: otherPointNum,
        totalPoint,
        newsId: newsInfo.newsId,
        proofId: transmitInfo.dataValues.id,
      }, { transaction });
      shareNewTotalPoint = totalPoint;
    }
  }).then(() => {
    // commit
    if (viewerNewTotalPoint >= 0) {
      globalController.addGlobalPoint(viewerInfo.userId, viewerNewTotalPoint);
    }
    if (shareNewTotalPoint >= 0) {
      globalController.addGlobalPoint(shareUserId, shareNewTotalPoint);
    }
  }).catch((err) => {
    // Rolled back
    logger.info(err);
  });
};

// 文章分享至朋友圈
exports.shareNewsById = (req, res) => {
  const newsId = parseInt(req.params.newsId, 0) || 0;
  const userId = req.session.user ? req.session.user.userId : '';
  const shareId = req.body.shareId || '';
  const resUtil = new HttpSend(req, res);

  // 检查参数
  if (!newsId || !userId) {
    resUtil.sendJson(constants.HTTP_FAIL, '参数错误,积分增加失败');
    return;
  }

  const mainFunction = async () => {
    try {
      const newsInfo = await Model.News.findOne({ where: { newsId } });
      if (!newsInfo || !newsInfo.dataValues) {
        resUtil.sendJson(constants.HTTP_FAIL, '资讯不存在,积分增加失败');
        return;
      }

      await exports.addTransmitLogByNewsId(newsInfo.dataValues, req.session.user, shareId);
      resUtil.sendJson(constants.HTTP_SUCCESS);
    } catch (err) {
      logger.info(err);
      resUtil.sendJson(constants.HTTP_FAIL, '系统错误,积分增加失败');
    }
  };

  mainFunction();
};

// 文章点赞
exports.thumbUpNewsById = (req, res) => {
  const newsId = parseInt(req.query.newsId, 0) || 0;
  const resUtil = new HttpSend(req, res);
  const userId = req.session.user ? req.session.user.userId : '';

  // 检查参数
  if (!newsId || !userId) {
    resUtil.sendJson(constants.HTTP_FAIL, '参数错误');
    return;
  }

  const mainFunction = async () => {
    try {
      // 查询是否已经点赞
      const thumbUpKey = redisUtil.getRedisPrefix(17, newsId);
      const ifThumb = await redisClient.hincrbyAsync(thumbUpKey, userId, 1);
      if (ifThumb > 1) {
        resUtil.sendJson(constants.HTTP_FAIL, '不能重复点赞');
        return;
      }

      const thumbUpRank = redisUtil.getRedisPrefix(1);
      const newThumbUpNum = await redisClient.zincrbyAsync(thumbUpRank, 1, newsId);

      resUtil.sendJson(constants.HTTP_SUCCESS, '', { newThumbUpNum });
    } catch (err) {
      logger.info(err);
      resUtil.sendJson(constants.HTTP_FAIL, '系统错误');
    }
  };

  mainFunction();
};

// 文章评论
exports.commentNewsById = (req, res) => {
  const newsId = parseInt(req.body.newsId, 0) || 0;
  const resUtil = new HttpSend(req, res);
  const userId = req.session.user ? req.session.user.userId : '';
  const comment = req.body.comment || '';


  // 检查参数
  if (!newsId || !userId || !comment) {
    resUtil.sendJson(constants.HTTP_FAIL, '参数错误');
    return;
  }

  const mainFunction = async () => {
    try {
      const commentInfo = {
        comment,
        userName: req.session.user.userName,
        userId: req.session.user.userId,
        headImgUrl: req.session.user.headImgUrl,
        commentTime: Date.now(),
      };

      const commentRankKey = redisUtil.getRedisPrefix(13);
      const rangeKey = redisUtil.getRedisPrefix(14, newsId);
      await redisClient.multi()
        .rpush(rangeKey, JSON.stringify(commentInfo))
        .zincrby(commentRankKey, 1, newsId)
        .execAsync();

      // 查询评论列表
      const commentInfos = await redisClient.lrangeAsync(rangeKey, 0, -1);
      const commentLength = commentInfos.length;
      const commentList = [];
      for (let i = (commentLength - 1); i >= 0; i -= 1) {
        commentList.push(JSON.parse(commentInfos[i]));
      }
      resUtil.sendJson(constants.HTTP_SUCCESS, '', { commentList });
    } catch (err) {
      logger.info(err);
      resUtil.sendJson(constants.HTTP_FAIL, '系统错误');
    }
  };

  mainFunction();
};

// 自测题详情页
exports.getTestDetailById = (req, res, next) => {
  const newsId = parseInt(req.params.newsId, 0) || 0;
  // 分享者id
  const shareId = req.query.shareId || '';
  const httpUtil = new HttpSend(req, res);

  if (!newsId) {
    const err = new Error('参数错误');
    next(err);
    return;
  }

  const mainFunction = async () => {
    try {
      // 检查newsId是否正确
      const newsInfo = await Model.News.findOne({ where: { newsId } });
      if (!newsInfo || !newsInfo.dataValues) {
        throw new Error('自测题不存在');
      }

      if (newsInfo.dataValues.type !== constants.TYPE_ESTIMATE) {
        throw new Error('资讯类型错误');
      }

      // 由于自测题目和答案都是UI切死图，所以这里去掉了查询题目这一步骤

      // 记录浏览日志
      exports.addViewLogByNewsId(newsInfo.dataValues, req.session.user, shareId);

      const newShareId = shareId === '' ? req.session.user.userId : shareId;
      const shareUrl = `${config.serverHost}/news/tests/${newsId}?shareId=${newShareId}`;
      httpUtil.render('test/test-tongfeng', {
        newsId,
        shareUid: newShareId,
        shareUrl,
        img: newsInfo.dataValues.imgUrl,
        title: newsInfo.dataValues.title,
      });
    } catch (err) {
      logger.info(err);
      next(err);
    }
  };

  mainFunction();
};

// 提交自测题
exports.finishTestById = async (req, res) => {
  const resUtil = new HttpSend(req, res);
  const newsId = parseInt(req.params.newsId, 0) || 0;
  const choiceList = req.body.choiceList || await resUtil.transferJson() || {};
  const userId = req.session.user.userId || '';

  // 检查参数
  if (!newsId || JSON.stringify(choiceList) === '{}' || !userId) {
    resUtil.sendJson(constants.HTTP_FAIL, '参数错误');
    return;
  }

  const calScore = async () => {
    const questionLists = await Model.SelfTest.findAll({
      where: { newsId },
      order: [['order', 'ASC']],
    });
    if (questionLists.length === 0) {
      throw new Error('自测题题目列表不存在');
    }

    let totalScore = 0;
    for (const questionInfo of questionLists) {
      const order = questionInfo.dataValues.order || 0;
      const userChoice = choiceList[order];
      const scores = JSON.parse(questionInfo.dataValues.scores || '');
      totalScore += parseInt(scores[userChoice] || 0, 0);
    }

    return totalScore;
  };

  const qryEstimate = async (totalScore) => {
    const estimate = await Model.SelfTestEstimate.findOne({
      where: {
        newsId,
        minScore: { [Op.lte]: totalScore },
        maxScore: { [Op.gte]: totalScore },
      },
    });
    if (!estimate || !estimate.dataValues) {
      throw new Error('自测评判标准查询失败');
    }

    return estimate.dataValues;
  };

  const uptRecord = (totalScore, estimateInfo, newsInfo) =>
    Model.SelfTestRecord.create({
      userId,
      userName: req.session.user.userName,
      headImg: req.session.user.headImgUrl,
      options: JSON.stringify(choiceList),
      totalScore,
      estimateId: estimateInfo.estimateId,
      estimate: estimateInfo.estimate,
      newsId,
      newsClass: newsInfo.dataValues.newsClass || 0,
      title: newsInfo.dataValues.title || '',
    });

  try {
    // 查询自测题相关信息,验证参数合法性
    const newsInfo = await Model.News.findOne({
      where: { newsId },
    });
    if (!newsInfo || !newsInfo.dataValues ||
      newsInfo.dataValues.type !== constants.TYPE_ESTIMATE) {
      resUtil.sendJson(constants.HTTP_FAIL, '参数错误');
      return;
    }


    // 查询自测题题目,计算得分
    const totalScore = await calScore();

    // 根据分数查询评价
    const estimateInfo = await qryEstimate(totalScore);

    // 异步更新评价结果至日志中
    uptRecord(totalScore, estimateInfo, newsInfo);

    resUtil.sendJson(constants.HTTP_SUCCESS);
  } catch (err) {
    logger.info(err);
    resUtil.sendJson(constants.HTTP_FAIL, '系统错误');
  }
};
