const { getTodaySummary } = require('../../utils/growth')

function getFlowerStage(streak) {
  if (streak >= 14) {
    return { name: '盛开', emoji: '🌸' }
  }
  if (streak >= 7) {
    return { name: '开花', emoji: '🌼' }
  }
  if (streak >= 3) {
    return { name: '长叶', emoji: '🌿' }
  }
  if (streak >= 1) {
    return { name: '发芽', emoji: '🌱' }
  }
  return { name: '种子', emoji: '🌰' }
}

Page({
  data: {
    practiceMinutesText: '0',
    practiceCount: 0,
    streak: 0,
    latestTip: '',
    hasLatestTip: false,
    flowerStageName: '种子',
    flowerStageEmoji: '🌰'
  },

  onShow() {
    const summary = getTodaySummary()
    const flowerStage = getFlowerStage(summary.streak)

    this.setData({
      practiceMinutesText: summary.practiceMinutesText,
      practiceCount: summary.practiceCount,
      streak: summary.streak,
      latestTip: summary.latestTip,
      hasLatestTip: Boolean(summary.latestTip),
      flowerStageName: flowerStage.name,
      flowerStageEmoji: flowerStage.emoji
    })
  }
})
