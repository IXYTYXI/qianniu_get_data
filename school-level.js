/**
 * 学段识别与列表筛选
 *
 * mergeMiddleHigh=true（或 MERGE_MIDDLE_HIGH=1）：小学 + 初高（初中/高中/初高 均归入初高）
 * mergeMiddleHigh=false（或 MERGE_MIDDLE_HIGH=0）：小学 + 初中 + 高中
 * 未配置：不筛列表，弹幕仍按三学段识别（不含初高）
 */

function isMergeMiddleHigh(config = {}) {
  const env = process.env.MERGE_MIDDLE_HIGH;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  return config.mergeMiddleHigh === true;
}

function shouldApplySchoolFilter(config = {}) {
  const env = process.env.MERGE_MIDDLE_HIGH;
  if (env === '1' || env === 'true' || env === '0' || env === 'false') return true;
  return config.mergeMiddleHigh !== undefined;
}

function getSchoolTableKeys(config = {}) {
  const keys = isMergeMiddleHigh(config)
    ? ['小学', '初高']
    : ['小学', '初中', '高中'];
  // 场次标题已使用【初高】标签时，始终需要初高弹幕表
  if (!keys.includes('初高')) keys.push('初高');
  return keys;
}

function detectSchoolLevel(text, config = {}) {
  const hay = String(text || '');
  const merge = isMergeMiddleHigh(config);

  if (/【初高】|初高/.test(hay)) {
    return '初高';
  }
  if (/【小学】/.test(hay) || (hay.includes('小学') && !hay.includes('初高'))) {
    return '小学';
  }

  if (merge) {
    if (/【初中】|初中/.test(hay)) return '初高';
    if (/【高中】|高中/.test(hay)) return '初高';
    return null;
  }

  if (/【初中】|初中/.test(hay)) return '初中';
  if (/【高中】|高中/.test(hay)) return '高中';
  return null;
}

function shouldIncludeLiveRow(text, config = {}) {
  if (!shouldApplySchoolFilter(config)) return true;
  return detectSchoolLevel(text, config) != null;
}

function describeSchoolMode(config = {}) {
  return isMergeMiddleHigh(config)
    ? '合并模式（小学 + 初高）'
    : '分学段模式（小学 + 初中 + 高中）';
}

module.exports = {
  isMergeMiddleHigh,
  shouldApplySchoolFilter,
  getSchoolTableKeys,
  detectSchoolLevel,
  shouldIncludeLiveRow,
  describeSchoolMode,
};
