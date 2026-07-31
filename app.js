App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库不支持云开发')
      return
    }

    wx.cloud.init({
      env: 'cloud1-d8gy9xmka4cf59d69',
      traceUser: true
    })
  }
})
