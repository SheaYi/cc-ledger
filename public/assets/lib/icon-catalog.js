/**
 * 图标库目录。
 *
 * 每个图标带三样东西：**形状名（Lucide 名）+ 中文名 + 搜索关键词**。
 *
 * 为什么要中文名：图标库里躺着 80 多个候选，用户找的是「咖啡」，
 * 不是 `coffee`。搜索框里敲英文才会命中，等于没有搜索。
 * 关键词是为了容差 —— 「的士」和「出租车」都应该找到 `car-taxi-front`。
 *
 * 分组是为了**浏览**：不知道要找什么时，按「餐饮 / 出行 / 购物」翻一遍，
 * 比在 80 个图标里扫视快得多。分组是软的：搜索时无视分组，跨组命中。
 *
 * ⚠️ 这里的每个名字都必须在 `scripts/gen-lucide.mjs` 的 PICKER 里登记过：
 * 该脚本**不扫前端源码**，漏登记的名字在 `lucide()` 里会静默回退成 `circle-help`，
 * 用户看到的就是一个问号，而控制台一行报错都没有。
 */
export const ICON_GROUPS = [
  {
    key: 'common',
    label: '常用',
    icons: [
      ['receipt', '票据', 'receipt 账单 发票 小票'],
      ['banknote', '钞票', 'money 钱 现金 纸币'],
      ['arrow-left-right', '转账', 'transfer 互转 划转'],
      ['hand-coins', '借出', 'lend 借款 往来'],
      ['heart-handshake', '应收', 'receivable 归还 人情'],
      ['wallet', '钱包', 'wallet 钱夹'],
      ['credit-card', '银行卡', 'card 信用卡 刷卡'],
      ['coins', '硬币', 'coin 零钱'],
      ['piggy-bank', '存钱罐', 'save 储蓄 存款'],
      ['landmark', '银行', 'bank 网点'],
      ['tag', '标签', 'tag 标记'],
      ['briefcase', '工作', 'work 公文包 办公'],
    ],
  },
  {
    key: 'food',
    label: '餐饮',
    icons: [
      ['utensils', '餐具', 'eat 吃饭 餐厅 饭'],
      ['coffee', '咖啡', 'coffee 奶茶 饮品 咖啡馆'],
      ['croissant', '面包', 'bread 早餐 烘焙'],
      ['beer', '啤酒', 'beer 酒 喝酒 夜宵'],
      ['wine', '红酒', 'wine 葡萄酒 酒'],
      ['cookie', '零食', 'snack 饼干 甜点'],
      ['apple', '水果', 'fruit 苹果 生鲜'],
    ],
  },
  {
    key: 'traffic',
    label: '出行',
    icons: [
      ['car-front', '汽车', 'car 开车 加油 停车'],
      ['tram-front', '地铁', 'metro 轨道交通 通勤'],
      ['bus', '公交', 'bus 巴士 通勤'],
      ['train-front', '火车', 'train 高铁 铁路'],
      ['plane', '飞机', 'flight 机票 航班 出差'],
      ['bike', '单车', 'bike 骑行 共享单车'],
      ['fuel', '加油', 'gas 加油站 油耗'],
      ['car-taxi-front', '出租车', 'taxi 的士 打车'],
    ],
  },
  {
    key: 'shopping',
    label: '购物',
    icons: [
      ['shopping-cart', '购物车', 'cart 买菜 超市'],
      ['shopping-bag', '购物袋', 'bag 买 购物'],
      ['shopping-basket', '篮子', 'basket 采买'],
      ['shirt', '衣服', 'cloth 服装 穿搭'],
      ['footprints', '鞋履', 'shoe 鞋子 鞋'],
      ['glasses', '眼镜', 'glasses 墨镜 配镜'],
      ['gift', '礼物', 'gift 礼品 送礼'],
      ['store', '便利店', 'store 小卖部 商铺'],
      ['package', '包裹', 'package 快递 物流 取件'],
      ['ticket', '门票', 'ticket 票 演出'],
    ],
  },
  {
    key: 'home',
    label: '居家',
    icons: [
      ['house', '住房', 'home 房租 房子 家'],
      ['building-2', '写字楼', 'building 办公楼 物业'],
      ['lightbulb', '电费', 'light 电 灯泡 照明'],
      ['droplet', '水费', 'water 水 自来水'],
      ['flame', '燃气', 'gas 煤气 取暖'],
      ['wifi', '宽带', 'network 网费 上网'],
      ['spray-can', '清洁', 'clean 打扫 保洁'],
      ['hammer', '维修', 'fix 修理 装修'],
      ['wrench', '工具', 'tool 扳手 养护'],
      ['scissors', '裁剪', 'cut 剪刀 理发'],
      ['brush', '洗护', 'wash 刷 洗漱'],
      ['tent', '露营', 'camp 户外 野营'],
      ['leaf', '绿植', 'plant 花 园艺'],
      ['flower-2', '花卉', 'flower 花 盆栽'],
      ['paw-print', '宠物', 'pet 猫 狗 猫狗'],
      ['baby', '母婴', 'baby 小孩 育儿'],
      ['sun', '天气', 'sun 晴天 太阳'],
      ['moon', '夜间', 'night 晚上 月亮'],
      ['snowflake', '冬天', 'winter 雪 冷'],
    ],
  },
  {
    key: 'health',
    label: '健康文教',
    icons: [
      ['stethoscope', '看病', 'doctor 医院 门诊 医疗'],
      ['pill', '药品', 'medicine 药 吃药'],
      ['heart-pulse', '体检', 'health 身体 心率'],
      ['dumbbell', '健身', 'gym 运动 锻炼'],
      ['graduation-cap', '上学', 'school 学费 毕业 教育'],
      ['book-open', '读书', 'book 书 看书 书籍'],
      ['pencil', '文具', 'pen 笔 写字 办公用品'],
      ['palette', '兴趣', 'hobby 画画 美术'],
      ['music', '音乐', 'music 歌 乐器'],
      ['clapperboard', '影视', 'movie 电影 视频 会员'],
      ['gamepad-2', '游戏', 'game 手柄 娱乐'],
      ['trophy', '比赛', 'win 奖杯 竞赛'],
      ['heart', '心意', 'love 爱心 喜欢'],
      ['bone', '宠物用品', 'dog 狗 骨头'],
    ],
  },
  {
    key: 'digital',
    label: '数码办公',
    icons: [
      ['smartphone', '手机', 'phone 话费 移动'],
      ['laptop', '电脑', 'computer 笔记本 办公'],
      ['monitor', '显示器', 'screen 屏幕 台式'],
      ['tv', '电视', 'tv 电视费 会员'],
      ['battery-charging', '充电', 'charge 电池 电量'],
      ['cloud', '云服务', 'cloud 网盘 会员 订阅'],
      ['printer', '打印', 'print 打印 复印'],
      ['paperclip', '附件', 'file 文件 附件'],
      ['calculator', '计算', 'calc 算账 记账'],
      ['megaphone', '推广', 'ad 广告 营销'],
      ['shield', '保险', 'insurance 保障 安全'],
      ['globe', '网络', 'web 上网 网站'],
    ],
  },
  {
    key: 'money',
    label: '资金',
    icons: [
      ['trending-up', '上涨', 'up 涨幅 收入 增长'],
      ['trending-down', '下降', 'down 跌幅 缩水'],
      ['percent', '折扣', 'discount 百分比 优惠'],
      ['scale', '余额调整', 'balance 天平 对账'],
      ['vault', '保险柜', 'safe 金库 资产'],
      ['gem', '贵重', 'jewel 珠宝 资产'],
      ['boxes', '库存', 'stock 存货 仓储'],
      ['link', '关联', 'link 链接 绑定'],
      ['ticket-percent', '优惠券', 'coupon 券 减免'],
    ],
  },
  {
    key: 'other',
    label: '其它',
    icons: [
      ['users', '人员', 'people 用户 成员'],
      ['check', '完成', 'done 勾选 已办'],
      ['clock', '时间', 'time 计时 钟'],
      ['star', '收藏', 'favorite 星标 关注'],
      ['zap', '快捷', 'fast 快速 闪电'],
      ['camera', '拍照', 'photo 相机 照片'],
      ['archive', '归档', 'archive 存档 收纳'],
      ['rotate-ccw', '退款', 'refund 退回 撤销'],
      ['list-filter', '筛选', 'filter 过滤 清单'],
      ['info', '说明', 'info 信息 提示'],
      ['plus', '新增', 'add 添加 加号'],
    ],
  },
];

/** 扁平表：弹层搜索时跨组命中 */
export const ICON_FLAT = ICON_GROUPS.flatMap((g) =>
  g.icons.map(([name, cn, kw]) => ({ name, cn, kw: `${kw} ${cn}`, group: g.key })),
);

const NAME_MAP = new Map(ICON_FLAT.map((i) => [i.name, i.cn]));

/** 图标的中文名；不在目录里时退回英文原名（至少不会显示成 undefined） */
export const iconNameOf = (name) => NAME_MAP.get(name) ?? name ?? '';
