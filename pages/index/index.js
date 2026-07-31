Page({
  data: {
    cloudCallMessage: ''
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

  testCloudFunction() {
    if (!wx.cloud) {
      this.setData({
        cloudCallMessage: '云函数调用失败'
      })
      return
    }

    this.setData({
      cloudCallMessage: ''
    })
    wx.cloud.callFunction({
      name: 'hello',
      success: ({ result }) => {
        console.log('hello 云函数返回:', result)
        this.setData({
          cloudCallMessage: '云函数调用成功'
        })
      },
      fail: (error) => {
        console.error('hello 云函数调用失败:', error)
        this.setData({
          cloudCallMessage: '云函数调用失败'
        })
      }
    })
  }
})
