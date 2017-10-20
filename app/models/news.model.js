module.exports = function (sequelize, DataTypes) {
  const News = sequelize.define('News', {
    // id
    newsId: {
      type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, unique: true,
    },
    // 作者名称
    writerName: { type: DataTypes.STRING, defaultValue: '管理员' },
    // 资讯内容地址链接
    redirectUrl: { type: DataTypes.STRING, allowNull: false, defaultValue: 1 },
    // 资讯所属类别 (eg. 糖尿病、痛风等)
    type: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    // 资讯标题
    title: { type: DataTypes.STRING },
    // 资讯简介
    introduction: { type: DataTypes.STRING },
    // 资讯展示配图地址
    imgUrl: { type: DataTypes.STRING },
    // 资讯展详细内容
    context: { type: DataTypes.TEXT },
  }, {
    timestamps: true,
    paranoid: true,
    freezeTableName: true,
    tableName: 'news',
    charset: 'utf8',
    collate: 'utf8_general_ci',
  });

  return News;
};
