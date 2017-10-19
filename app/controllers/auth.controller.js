const Model = require('../models/index');
const HttpSend = require('../utils/http.util');
const config = require('../../config/config');
const constants = require('../../config/constants');
const OAuth = require('wechat-oauth');
const url = require('url');

// 自动登陆、自动注册
const autoLoginAndRegister = (req, res) => {
  const openId = req.query.openId || '';
  const userName = req.query.userName || '';
  const sex = req.query.sex || 1;
  const province = req.query.province || '湖北省';
  const city = req.query.city || '武汉市';
  const country = req.query.country || '中国';
  const headImgUrl = req.query.headImgUrl || '';
  const resUtil = new HttpSend(req, res);

  // 参数验证
  if (!openId) {
    resUtil.sendJson(constants.HTTP_FAIL, '获取微信相关信息失败');
    return;
  }

  const mainFunction = async () => {
    try {
      let userInfo = await Model.User.findOne({ where: { openId } });

      // 不存在则自动注册
      if (!userInfo || !userInfo.dataValues) {
        userInfo = await Model.User.create({
          openId,
          userName,
          sex,
          province,
          city,
          country,
          headImgUrl,
        });
      } else if (userName !== userInfo.dataValues.userName || sex !== userInfo.dataValues.sex ||
          province !== userInfo.dataValues.province || city !== userInfo.dataValues.city ||
          country !== userInfo.dataValues.country || headImgUrl !== userInfo.dataValues.headImgUrl
      ) {
        // 如果存在但是发生了信息变更，更新信息
        await Model.User.update({
          userName,
          sex,
          province,
          city,
          country,
          headImgUrl,
        }, { where: { openId } });
      }

      req.session.user = {
        userName: userInfo.dataValues.userName,
        createdAt: userInfo.dataValues.createdAt,
        userId: userInfo.dataValues.userId,
        openId: userInfo.dataValues.openId,
        sex: userInfo.dataValues.sex,
        province: userInfo.dataValues.province,
        city: userInfo.dataValues.city,
        country: userInfo.dataValues.country,
        headImgUrl: userInfo.dataValues.headImgUrl,
      };

      // 如果有跳转前页面，先进入
      const originalUrl = req.session.originalUrl || `${config.serverHost}:${config.serverPort}/`;
      req.session.originalUrl = null;
      res.redirect(originalUrl);
    } catch (err) {
      console.log(err);
      resUtil.sendJson(constants.HTTP_FAIL, '自动登陆出错');
    }
  };

  mainFunction();
};

// 登录请求主入口
exports.login = (req, res, next) => {
  const weChatFlag = exports.isFromWeChat(req);
  if (weChatFlag) {
    // 跳转 获取用户授权的code  微信不接受80端口以外的回调
    const api = new OAuth(config.weChatConfig.appId, config.weChatConfig.appSecret);
    const weChatUrl = api.getAuthorizeURL(`${config.serverHost}/auth/weChatCode`, '', 'snsapi_userinfo');
    res.redirect(weChatUrl);
  } else {
    const error = new Error('请从微信浏览器登入');
    next(error);
  }
};

// 获取用户微信userInfo
exports.weChatCodeGet = (req, res) => {
  const code = req.query.code || '';
  const api = new OAuth(config.weChatConfig.appId, config.weChatConfig.appSecret);
  api.getAccessToken(code, (err, result) => {
    if (err || !result || !result.data) {
      res.end(result.errCode);
    } else {
      req.query.openId = result.data.openid || '';
      req.query.userName = result.data.nickname || '';
      req.query.sex = result.data.sex || 1;
      req.query.province = result.data.province || '';
      req.query.city = result.data.city || '';
      req.query.country = result.data.country || '';
      req.query.headImgUrl = result.data.headimgurl || '';
      autoLoginAndRegister(req, res);
    }
  });
};

// 中间件：判断是否已经登录
exports.isLogin = (req, res, next) => {
  const userInfo = req.session.user || {};

  // 记载用户的起始url，方便登录/注册后跳转
  const originalUrl = url.format({
    protocol: req.protocol,
    host: req.get('host'),
    pathname: req.originalUrl,
  });
  req.session.originalUrl = originalUrl;

  if (!userInfo || !userInfo.userId) {
    res.redirect(`${config.serverHost}:${config.serverPort}/auth/login`);
  } else {
    next();
  }
};

// 判断请求是否来自微信客户端
exports.isFromWeChat = (req) => {
  const ua = req.header('user-agent').toLowerCase();
  const flags = ua.match(/MicroMessenger/i);
  if (flags && flags[0] === 'micromessenger') {
    return true;
  }
  return false;
};

// 微信绑定域名时会回调的接口
exports.checkSignature = (req, res) => {
  const token = config.weChatConfig.token || '';
  const timestamp = req.query.timestamp || '';
  const nonce = req.query.nonce || '';
  const signature = req.query.signature || '';
  const echostr = req.query.echostr || '';
  const key = [token, timestamp, nonce].sort().join('');
  // 将token （自己设置的） 、timestamp（时间戳）、nonce（随机数）三个参数进行字典排序
  const sha1 = require('crypto').createHash('sha1');
  // 将上面三个字符串拼接成一个字符串再进行sha1加密
  sha1.update(key);
  const result = sha1.digest('hex') === signature;
  if (result) {
    res.end(echostr);
  } else {
    res.end(result);
  }
};

