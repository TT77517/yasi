const { getTodaySummary } = require('../../utils/growth')

Page({
  data: {
    todayPracticeMinutes: '0',
    streakDays: 0
  },

  onShow() {
    const summary = getTodaySummary()
    this.setData({
      todayPracticeMinutes: summary.practiceMinutesText,
      streakDays: summary.streak
    })
  },

  openPractice() {
    wx.navigateTo({
      url: '/pages/practice/index'
    })
  },

  openMock() {
    wx.navigateTo({
      url: '/pages/mock/index'
    })
  },

  openGarden() {
    wx.navigateTo({
      url: '/pages/garden/index'
    })
  }
})
