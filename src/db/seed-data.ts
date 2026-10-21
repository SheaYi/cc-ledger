/**
 * 预置数据模板（docs/03 §2 预置数据、docs/03 §4 分类体系）。
 *
 * 主键规则：seedId(ledgerId, key) => `${ledgerId}#${key}`，保证多账本间不冲突。
 * 图标统一使用 Lucide 开源图标库（ISC）的图标名，前端经 lucide-data.js 渲染。
 *
 * 分类体系（覆盖市面主流记账场景）：
 *   支出 20 个主类别 + 156 个子类别；
 *   收入 4 个主类别 + 29 个子类别；
 *   应收 / 应付沿用账务设计的三层小结构。
 * 内置分类（is_default=1）不可改名，可停用（归档）不用的分类。
 */

export interface SeedAccountGroup {
  key: string;
  name: string;
  kind: 'asset' | 'liability' | 'virtual';
  icon: string;
  sortOrder: number;
}

export interface SeedTag {
  key: string;
  name: string;
  color: string;
}

export interface SeedCategoryNode {
  key: string;
  name: string;
  icon: string;
  children: { key: string; name: string; icon: string }[];
}

export interface SeedCategoryTree {
  recordType: 'expense' | 'income' | 'receivable' | 'payable';
  parents: SeedCategoryNode[];
}

export interface SeedTemplate {
  key: string;
  name: string;
  icon: string;
  recordType: 'expense';
  groupKey: string;
  categoryKey: string;
  title: string;
  defaultAmount: number; // 分
}

/* ---------- 一、账户分组（6 个） ---------- */
export const DEFAULT_ACCOUNT_GROUPS: SeedAccountGroup[] = [
  { key: 'grp_cash', name: '现金', kind: 'asset', icon: 'banknote', sortOrder: 1 },
  { key: 'grp_bank', name: '银行卡', kind: 'asset', icon: 'landmark', sortOrder: 2 },
  { key: 'grp_credit', name: '信用卡', kind: 'liability', icon: 'credit-card', sortOrder: 3 },
  { key: 'grp_thirdparty', name: '第三方支付', kind: 'asset', icon: 'smartphone', sortOrder: 4 },
  { key: 'grp_invest', name: '投资', kind: 'asset', icon: 'trending-up', sortOrder: 5 },
  { key: 'grp_virtual', name: '虚拟账户', kind: 'virtual', icon: 'link', sortOrder: 6 },
];

/* ---------- 二、标签（8 个） ---------- */
export const DEFAULT_TAGS: SeedTag[] = [
  { key: 'tag_essential', name: '必需', color: '#FF3B30' },
  { key: 'tag_nonessential', name: '非必需', color: '#34C759' },
  { key: 'tag_planned', name: '计划内', color: '#007AFF' },
  { key: 'tag_unplanned', name: '计划外', color: '#FF9500' },
  { key: 'tag_reimbursable', name: '可报销', color: '#AF52DE' },
  { key: 'tag_reimbursed', name: '已报销', color: '#8E8E93' },
  { key: 'tag_shared', name: '共享', color: '#FFCC00' },
  { key: 'tag_paid_for_other', name: '代付', color: '#636366' },
];

/* ---------- 三、分类体系（支出 20 主类 / 收入 4 主类） ---------- */
export const DEFAULT_CATEGORY_TREES: SeedCategoryTree[] = [
  {
    recordType: 'expense',
    parents: [
      {
        key: 'expense_food',
        name: '餐饮',
        icon: 'utensils',
        children: [
          { key: 'expense_food_breakfast', name: '早餐', icon: 'croissant' },
          { key: 'expense_food_lunch', name: '午餐', icon: 'utensils' },
          { key: 'expense_food_dinner', name: '晚餐', icon: 'soup' },
          { key: 'expense_food_takeout', name: '外卖', icon: 'bike' },
          { key: 'expense_food_snack', name: '零食', icon: 'cookie' },
          { key: 'expense_food_drink', name: '饮料', icon: 'cup-soda' },
          { key: 'expense_food_coffee', name: '咖啡', icon: 'coffee' },
          { key: 'expense_food_fruit', name: '水果', icon: 'apple' },
          { key: 'expense_food_restaurant', name: '下馆子', icon: 'utensils-crossed' },
          { key: 'expense_food_alcohol', name: '烟酒', icon: 'wine' },
        ],
      },
      {
        key: 'expense_traffic',
        name: '交通',
        icon: 'car-front',
        children: [
          { key: 'expense_traffic_bus', name: '公交', icon: 'bus' },
          { key: 'expense_traffic_metro', name: '地铁', icon: 'tram-front' },
          { key: 'expense_traffic_taxi', name: '打车', icon: 'car-taxi-front' },
          { key: 'expense_traffic_fuel', name: '加油', icon: 'fuel' },
          { key: 'expense_traffic_parking', name: '停车', icon: 'circle-parking' },
          { key: 'expense_traffic_toll', name: '过路费', icon: 'milestone' },
          { key: 'expense_traffic_wash', name: '洗车', icon: 'droplets' },
          { key: 'expense_traffic_maintain', name: '车辆保养', icon: 'wrench' },
          { key: 'expense_traffic_repair', name: '车辆维修', icon: 'hammer' },
          { key: 'expense_traffic_insurance', name: '车险', icon: 'shield-check' },
          { key: 'expense_traffic_annual', name: '年检', icon: 'clipboard-check' },
          { key: 'expense_traffic_train', name: '火车', icon: 'train-front' },
          { key: 'expense_traffic_plane', name: '飞机', icon: 'plane' },
          { key: 'expense_traffic_bike', name: '共享单车', icon: 'bike' },
        ],
      },
      {
        key: 'expense_shopping',
        name: '购物',
        icon: 'shopping-cart',
        children: [
          { key: 'expense_shopping_daily', name: '日用百货', icon: 'shopping-basket' },
          { key: 'expense_shopping_personal', name: '个护清洁', icon: 'spray-can' },
          { key: 'expense_shopping_home', name: '家居用品', icon: 'armchair' },
          { key: 'expense_shopping_appliance', name: '数码电器', icon: 'tv' },
          { key: 'expense_shopping_textile', name: '家纺布艺', icon: 'bed' },
          { key: 'expense_shopping_hardware', name: '五金工具', icon: 'hammer' },
          { key: 'expense_shopping_gift', name: '礼品', icon: 'gift' },
          { key: 'expense_shopping_other', name: '其他购物', icon: 'package' },
        ],
      },
      {
        key: 'expense_clothing',
        name: '服饰',
        icon: 'shirt',
        children: [
          { key: 'expense_clothing_top', name: '上衣', icon: 'shirt' },
          { key: 'expense_clothing_pants', name: '裤装', icon: 'layers' },
          { key: 'expense_clothing_shoes', name: '鞋靴', icon: 'footprints' },
          { key: 'expense_clothing_underwear', name: '内衣袜', icon: 'package' },
          { key: 'expense_clothing_coat', name: '外套', icon: 'wind' },
          { key: 'expense_clothing_accessory', name: '配饰', icon: 'glasses' },
          { key: 'expense_clothing_bag', name: '箱包', icon: 'briefcase' },
          { key: 'expense_clothing_haircut', name: '理发美发', icon: 'scissors' },
        ],
      },
      {
        key: 'expense_housing',
        name: '居住',
        icon: 'house',
        children: [
          { key: 'expense_housing_rent', name: '房租', icon: 'house' },
          { key: 'expense_housing_mortgage', name: '房贷', icon: 'landmark' },
          { key: 'expense_housing_property', name: '物业费', icon: 'building-2' },
          { key: 'expense_housing_water', name: '水费', icon: 'droplet' },
          { key: 'expense_housing_electricity', name: '电费', icon: 'zap' },
          { key: 'expense_housing_gas', name: '燃气费', icon: 'flame' },
          { key: 'expense_housing_heating', name: '取暖费', icon: 'thermometer' },
          { key: 'expense_housing_broadband', name: '宽带费', icon: 'wifi' },
          { key: 'expense_housing_cleaning', name: '家政保洁', icon: 'spray-can' },
          { key: 'expense_housing_appliance', name: '家电维修', icon: 'washing-machine' },
          { key: 'expense_housing_renovation', name: '装修', icon: 'paint-roller' },
        ],
      },
      {
        key: 'expense_telecom',
        name: '通讯',
        icon: 'smartphone',
        children: [
          { key: 'expense_telecom_phone', name: '手机话费', icon: 'smartphone' },
          { key: 'expense_telecom_data', name: '流量充值', icon: 'signal' },
          { key: 'expense_telecom_broadband', name: '宽带', icon: 'wifi' },
          { key: 'expense_telecom_express', name: '快递邮费', icon: 'package' },
          { key: 'expense_telecom_cloud', name: '云服务', icon: 'cloud' },
        ],
      },
      {
        key: 'expense_entertainment',
        name: '娱乐',
        icon: 'clapperboard',
        children: [
          { key: 'expense_ent_movie', name: '电影', icon: 'clapperboard' },
          { key: 'expense_ent_game', name: '游戏', icon: 'gamepad-2' },
          { key: 'expense_ent_show', name: '演出展览', icon: 'drama' },
          { key: 'expense_ent_subscription', name: '会员订阅', icon: 'crown' },
          { key: 'expense_ent_bar', name: '酒吧', icon: 'beer' },
          { key: 'expense_ent_ktv', name: 'KTV', icon: 'mic' },
          { key: 'expense_ent_toy', name: '玩具', icon: 'blocks' },
          { key: 'expense_ent_media', name: '书籍影音', icon: 'book-open' },
          { key: 'expense_ent_ticket', name: '旅游门票', icon: 'ticket' },
        ],
      },
      {
        key: 'expense_medical',
        name: '医疗健康',
        icon: 'heart-pulse',
        children: [
          { key: 'expense_medical_clinic', name: '门诊', icon: 'stethoscope' },
          { key: 'expense_medical_drug', name: '药品', icon: 'pill' },
          { key: 'expense_medical_hospital', name: '住院', icon: 'bed' },
          { key: 'expense_medical_checkup', name: '体检', icon: 'activity' },
          { key: 'expense_medical_dental', name: '牙科', icon: 'smile' },
          { key: 'expense_medical_eye', name: '眼科', icon: 'eye' },
          { key: 'expense_medical_supplement', name: '保健品', icon: 'leaf' },
          { key: 'expense_medical_device', name: '医疗器械', icon: 'syringe' },
          { key: 'expense_medical_psych', name: '心理咨询', icon: 'brain' },
        ],
      },
      {
        key: 'expense_insurance',
        name: '保险',
        icon: 'shield',
        children: [
          { key: 'expense_insurance_critical', name: '重疾险', icon: 'shield-alert' },
          { key: 'expense_insurance_medical', name: '医疗险', icon: 'shield-plus' },
          { key: 'expense_insurance_life', name: '寿险', icon: 'heart-handshake' },
          { key: 'expense_insurance_accident', name: '意外险', icon: 'triangle-alert' },
          { key: 'expense_insurance_car', name: '车险', icon: 'car-front' },
          { key: 'expense_insurance_property', name: '财产险', icon: 'house' },
          { key: 'expense_insurance_social', name: '社保', icon: 'badge-check' },
          { key: 'expense_insurance_fund', name: '公积金', icon: 'piggy-bank' },
        ],
      },
      {
        key: 'expense_education',
        name: '教育',
        icon: 'graduation-cap',
        children: [
          { key: 'expense_edu_tuition', name: '学费', icon: 'graduation-cap' },
          { key: 'expense_edu_training', name: '培训费', icon: 'presentation' },
          { key: 'expense_edu_stationery', name: '教材文具', icon: 'pencil' },
          { key: 'expense_edu_class', name: '课外班', icon: 'palette' },
          { key: 'expense_edu_online', name: '在线课程', icon: 'monitor-play' },
          { key: 'expense_edu_exam', name: '考试报名', icon: 'clipboard-list' },
          { key: 'expense_edu_cert', name: '考证', icon: 'award' },
        ],
      },
      {
        key: 'expense_social',
        name: '人情往来',
        icon: 'gift',
        children: [
          { key: 'expense_social_redpacket', name: '红包', icon: 'wallet-cards' },
          { key: 'expense_social_cashgift', name: '礼金', icon: 'gift' },
          { key: 'expense_social_treat', name: '请客', icon: 'utensils' },
          { key: 'expense_social_elder', name: '孝敬长辈', icon: 'heart-handshake' },
          { key: 'expense_social_chipin', name: '随份子', icon: 'heart' },
          { key: 'expense_social_donate', name: '慈善捐赠', icon: 'hand-heart' },
          { key: 'expense_social_present', name: '送礼', icon: 'shopping-bag' },
        ],
      },
      {
        key: 'expense_baby',
        name: '育儿',
        icon: 'baby',
        children: [
          { key: 'expense_baby_milk', name: '奶粉', icon: 'milk' },
          { key: 'expense_baby_diaper', name: '尿不湿', icon: 'baby' },
          { key: 'expense_baby_clothes', name: '童装', icon: 'shirt' },
          { key: 'expense_baby_toy', name: '玩具', icon: 'blocks' },
          { key: 'expense_baby_earlyedu', name: '早教', icon: 'puzzle' },
          { key: 'expense_baby_daycare', name: '托育', icon: 'school' },
          { key: 'expense_baby_medical', name: '儿童医疗', icon: 'stethoscope' },
          { key: 'expense_baby_insurance', name: '儿童保险', icon: 'shield' },
        ],
      },
      {
        key: 'expense_pet',
        name: '宠物',
        icon: 'paw-print',
        children: [
          { key: 'expense_pet_food', name: '宠物主粮', icon: 'wheat' },
          { key: 'expense_pet_snack', name: '宠物零食', icon: 'bone' },
          { key: 'expense_pet_medical', name: '宠物医疗', icon: 'stethoscope' },
          { key: 'expense_pet_supplies', name: '宠物用品', icon: 'shopping-basket' },
          { key: 'expense_pet_grooming', name: '宠物美容', icon: 'scissors' },
          { key: 'expense_pet_boarding', name: '宠物寄养', icon: 'house' },
        ],
      },
      {
        key: 'expense_sports',
        name: '运动健身',
        icon: 'dumbbell',
        children: [
          { key: 'expense_sports_gym', name: '健身卡', icon: 'credit-card' },
          { key: 'expense_sports_gear', name: '运动装备', icon: 'backpack' },
          { key: 'expense_sports_ball', name: '球类', icon: 'circle-dot' },
          { key: 'expense_sports_venue', name: '场地费', icon: 'map-pin' },
          { key: 'expense_sports_outdoor', name: '户外露营', icon: 'tent' },
          { key: 'expense_sports_swim', name: '游泳', icon: 'waves' },
          { key: 'expense_sports_race', name: '赛事报名', icon: 'trophy' },
        ],
      },
      {
        key: 'expense_travel',
        name: '旅行',
        icon: 'plane',
        children: [
          { key: 'expense_travel_flight', name: '机票', icon: 'plane' },
          { key: 'expense_travel_hotel', name: '酒店', icon: 'hotel' },
          { key: 'expense_travel_local', name: '当地交通', icon: 'bus' },
          { key: 'expense_travel_ticket', name: '景点门票', icon: 'ticket' },
          { key: 'expense_travel_group', name: '跟团游', icon: 'users' },
          { key: 'expense_travel_visa', name: '签证', icon: 'stamp' },
          { key: 'expense_travel_shopping', name: '旅行购物', icon: 'shopping-bag' },
          { key: 'expense_travel_insurance', name: '旅行保险', icon: 'shield' },
        ],
      },
      {
        key: 'expense_beauty',
        name: '美容护理',
        icon: 'sparkles',
        children: [
          { key: 'expense_beauty_cosmetic', name: '化妆品', icon: 'wand-sparkles' },
          { key: 'expense_beauty_skincare', name: '护肤品', icon: 'droplet' },
          { key: 'expense_beauty_nail', name: '美甲', icon: 'hand' },
          { key: 'expense_beauty_spa', name: '美容SPA', icon: 'flower-2' },
          { key: 'expense_beauty_medical', name: '医美', icon: 'syringe' },
          { key: 'expense_beauty_lash', name: '美睫', icon: 'eye' },
        ],
      },
      {
        key: 'expense_digital',
        name: '数码科技',
        icon: 'monitor-smartphone',
        children: [
          { key: 'expense_digital_phone', name: '手机', icon: 'smartphone' },
          { key: 'expense_digital_computer', name: '电脑', icon: 'laptop' },
          { key: 'expense_digital_accessory', name: '外设配件', icon: 'mouse' },
          { key: 'expense_digital_software', name: '软件购买', icon: 'app-window' },
          { key: 'expense_digital_home', name: '智能家居', icon: 'house-plug' },
          { key: 'expense_digital_game', name: '游戏设备', icon: 'gamepad-2' },
          { key: 'expense_digital_charger', name: '充电设备', icon: 'battery-charging' },
        ],
      },
      {
        key: 'expense_office',
        name: '办公经营',
        icon: 'briefcase',
        children: [
          { key: 'expense_office_supply', name: '办公用品', icon: 'paperclip' },
          { key: 'expense_office_print', name: '打印耗材', icon: 'printer' },
          { key: 'expense_office_trip', name: '差旅', icon: 'plane-takeoff' },
          { key: 'expense_office_team', name: '团建', icon: 'users' },
          { key: 'expense_office_saas', name: '软件服务', icon: 'cloud' },
          { key: 'expense_office_ad', name: '广告推广', icon: 'megaphone' },
          { key: 'expense_office_purchase', name: '设备采购', icon: 'monitor' },
          { key: 'expense_office_hosting', name: '商务招待', icon: 'wine' },
        ],
      },
      {
        key: 'expense_finance',
        name: '金融支出',
        icon: 'landmark',
        children: [
          { key: 'expense_finance_fee', name: '手续费', icon: 'percent' },
          { key: 'expense_finance_interest', name: '利息支出', icon: 'trending-down' },
          { key: 'expense_finance_tax', name: '税费', icon: 'receipt' },
          { key: 'expense_finance_penalty', name: '罚款违约金', icon: 'gavel' },
          { key: 'expense_finance_annualfee', name: '信用卡年费', icon: 'credit-card' },
          { key: 'expense_finance_loss', name: '投资亏损', icon: 'arrow-down-right' },
          { key: 'expense_finance_exchange', name: '兑换损失', icon: 'arrow-left-right' },
        ],
      },
      {
        key: 'expense_other',
        name: '其他支出',
        icon: 'ellipsis',
        children: [
          { key: 'expense_other_unsorted', name: '待分类', icon: 'inbox' },
          { key: 'expense_other_lost', name: '丢失', icon: 'search-x' },
          { key: 'expense_other_misc', name: '其他', icon: 'circle-help' },
        ],
      },
    ],
  },
  {
    recordType: 'income',
    parents: [
      {
        key: 'income_work',
        name: '职业收入',
        icon: 'banknote',
        children: [
          { key: 'income_work_salary', name: '工资', icon: 'banknote' },
          { key: 'income_work_bonus', name: '奖金', icon: 'medal' },
          { key: 'income_work_overtime', name: '加班费', icon: 'clock' },
          { key: 'income_work_allowance', name: '补贴', icon: 'wallet' },
          { key: 'income_work_yearly', name: '年终奖', icon: 'award' },
          { key: 'income_work_commission', name: '提成', icon: 'percent' },
          { key: 'income_work_fund', name: '公积金提取', icon: 'piggy-bank' },
        ],
      },
      {
        key: 'income_business',
        name: '经营收入',
        icon: 'store',
        children: [
          { key: 'income_business_revenue', name: '营业收入', icon: 'store' },
          { key: 'income_business_project', name: '项目款', icon: 'folder-open' },
          { key: 'income_business_share', name: '分销分成', icon: 'share-2' },
          { key: 'income_business_commission', name: '带货佣金', icon: 'shopping-bag' },
        ],
      },
      {
        key: 'income_invest',
        name: '投资理财',
        icon: 'trending-up',
        children: [
          { key: 'income_invest_fund', name: '基金收益', icon: 'chart-pie' },
          { key: 'income_invest_stock', name: '股票收益', icon: 'chart-candlestick' },
          { key: 'income_invest_interest', name: '利息收入', icon: 'percent' },
          { key: 'income_invest_wealth', name: '理财收益', icon: 'wallet' },
          { key: 'income_invest_bond', name: '债券收益', icon: 'file-text' },
          { key: 'income_invest_gold', name: '黄金收益', icon: 'coins' },
          { key: 'income_invest_rent', name: '房租收入', icon: 'house' },
          { key: 'income_invest_dividend', name: '分红', icon: 'hand-coins' },
        ],
      },
      {
        key: 'income_other',
        name: '其他收入',
        icon: 'circle-dollar-sign',
        children: [
          { key: 'income_other_parttime', name: '兼职外快', icon: 'briefcase' },
          { key: 'income_other_reimburse', name: '报销回款', icon: 'receipt' },
          { key: 'income_other_refund', name: '退款', icon: 'rotate-ccw' },
          { key: 'income_other_redpacket', name: '红包', icon: 'wallet-cards' },
          { key: 'income_other_cashgift', name: '礼金', icon: 'gift' },
          { key: 'income_other_lottery', name: '中奖', icon: 'trophy' },
          { key: 'income_other_secondhand', name: '二手闲置', icon: 'recycle' },
          { key: 'income_other_claim', name: '保险理赔', icon: 'shield-check' },
          { key: 'income_other_compensation', name: '赔偿', icon: 'hand-heart' },
          { key: 'income_other_misc', name: '其他收入', icon: 'circle-help' },
        ],
      },
    ],
  },
  {
    recordType: 'receivable',
    parents: [
      {
        key: 'receivable_loan',
        name: '借款',
        icon: 'hand-coins',
        children: [
          { key: 'receivable_loan_lend', name: '借出借款', icon: 'hand-coins' },
          { key: 'receivable_loan_friend', name: '借给朋友', icon: 'users' },
        ],
      },
      {
        key: 'receivable_advance',
        name: '垫付款',
        icon: 'receipt',
        children: [
          { key: 'receivable_advance_cost', name: '代垫费用', icon: 'credit-card' },
          { key: 'receivable_advance_goods', name: '代付货款', icon: 'package' },
        ],
      },
      {
        key: 'receivable_other',
        name: '其他应收',
        icon: 'file-text',
        children: [
          { key: 'receivable_other_ar', name: '应收账款', icon: 'file-text' },
          { key: 'receivable_other_deposit', name: '押金保证金', icon: 'lock' },
          { key: 'receivable_other_misc', name: '其他应收', icon: 'list' },
        ],
      },
    ],
  },
  {
    recordType: 'payable',
    parents: [
      {
        key: 'payable_consume',
        name: '消费待付',
        icon: 'shopping-cart',
        children: [
          { key: 'payable_consume_rent', name: '房租待付', icon: 'house' },
          { key: 'payable_consume_bill', name: '账单待付', icon: 'file-text' },
          { key: 'payable_consume_credit', name: '信用卡待还', icon: 'credit-card' },
        ],
      },
      {
        key: 'payable_debt',
        name: '债务待付',
        icon: 'hand-coins',
        children: [
          { key: 'payable_debt_goods', name: '货款待付', icon: 'package' },
          { key: 'payable_debt_loan', name: '借款待还', icon: 'hand-coins' },
        ],
      },
      {
        key: 'payable_other',
        name: '其他应付',
        icon: 'list',
        children: [
          { key: 'payable_other_deposit', name: '押金待退', icon: 'lock-open' },
          { key: 'payable_other_prepay', name: '预付款', icon: 'clock' },
          { key: 'payable_other_misc', name: '其他应付', icon: 'list' },
        ],
      },
    ],
  },
];

/* ---------- 四、模板（8 个） ---------- */
export const DEFAULT_TEMPLATES: SeedTemplate[] = [
  {
    key: 'tpl_breakfast',
    name: '早餐',
    icon: 'croissant',
    recordType: 'expense',
    groupKey: 'grp_cash',
    categoryKey: 'expense_food_breakfast',
    title: '早餐',
    defaultAmount: 800,
  },
  {
    key: 'tpl_lunch',
    name: '午餐',
    icon: 'utensils',
    recordType: 'expense',
    groupKey: 'grp_thirdparty',
    categoryKey: 'expense_food_lunch',
    title: '午餐',
    defaultAmount: 2500,
  },
  {
    key: 'tpl_metro',
    name: '地铁通勤',
    icon: 'tram-front',
    recordType: 'expense',
    groupKey: 'grp_thirdparty',
    categoryKey: 'expense_traffic_bus',
    title: '地铁',
    defaultAmount: 400,
  },
  {
    key: 'tpl_taxi',
    name: '打车',
    icon: 'car-taxi-front',
    recordType: 'expense',
    groupKey: 'grp_thirdparty',
    categoryKey: 'expense_traffic_taxi',
    title: '打车',
    defaultAmount: 3000,
  },
  {
    key: 'tpl_grocery',
    name: '买菜',
    icon: 'shopping-basket',
    recordType: 'expense',
    groupKey: 'grp_thirdparty',
    categoryKey: 'expense_shopping_daily',
    title: '买菜',
    defaultAmount: 6000,
  },
  {
    key: 'tpl_coffee',
    name: '咖啡',
    icon: 'coffee',
    recordType: 'expense',
    groupKey: 'grp_thirdparty',
    categoryKey: 'expense_food_coffee',
    title: '咖啡',
    defaultAmount: 2500,
  },
  {
    key: 'tpl_refuel',
    name: '加油',
    icon: 'fuel',
    recordType: 'expense',
    groupKey: 'grp_bank',
    categoryKey: 'expense_traffic_fuel',
    title: '加油',
    defaultAmount: 30000,
  },
  {
    key: 'tpl_express',
    name: '快递',
    icon: 'package',
    recordType: 'expense',
    groupKey: 'grp_thirdparty',
    categoryKey: 'expense_telecom_express',
    title: '快递',
    defaultAmount: 1500,
  },
];
