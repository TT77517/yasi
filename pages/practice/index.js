Page({
  data: {
    status: 'idle',
    tempFilePath: '',
    fileID: ''
  },

  analysisTimer: null,
  uploadTask: null,
  recorderManager: null,
  handleRecorderStop: null,
  handleRecorderError: null,
  isRecording: false,
  isPageActive: false,

  onLoad() {
    this.isPageActive = true
    this.recorderManager = wx.getRecorderManager()
    this.handleRecorderStop = (result) => {
      this.onRecordStop(result)
    }
    this.handleRecorderError = (error) => {
      this.onRecordError(error)
    }
    this.recorderManager.onStop(this.handleRecorderStop)
    this.recorderManager.onError(this.handleRecorderError)
  },

  startRecord() {
    wx.getSetting({
      success: ({ authSetting }) => {
        const recordPermission = authSetting['scope.record']

        if (recordPermission === true) {
          this.beginRecording()
          return
        }

        if (recordPermission === false) {
          this.showRecordPermissionDialog()
          return
        }

        wx.authorize({
          scope: 'scope.record',
          success: () => {
            this.beginRecording()
          },
          fail: () => {
            this.showRecordPermissionDialog()
          }
        })
      },
      fail: () => {
        wx.showToast({
          title: '无法获取录音权限',
          icon: 'none'
        })
      }
    })
  },

  beginRecording() {
    if (!this.recorderManager || !this.isPageActive) {
      return
    }

    this.recorderManager.start({
      format: 'mp3'
    })
    this.isRecording = true
    this.setData({
      status: 'recording',
      tempFilePath: '',
      fileID: ''
    })
  },

  showRecordPermissionDialog() {
    wx.showModal({
      title: '需要麦克风权限',
      content: '请在设置中允许使用麦克风后重试。',
      confirmText: '去设置',
      success: ({ confirm }) => {
        if (!confirm) {
          return
        }

        wx.openSetting({
          success: ({ authSetting }) => {
            if (authSetting['scope.record']) {
              this.beginRecording()
            }
          }
        })
      }
    })
  },

  stopRecord() {
    if (this.recorderManager && this.isRecording) {
      this.isRecording = false
      this.recorderManager.stop()
    }
  },

  onRecordStop({ tempFilePath }) {
    this.isRecording = false
    console.log('录音临时文件路径:', tempFilePath)

    if (
      !this.isPageActive ||
      this.uploadTask ||
      this.data.status !== 'recording'
    ) {
      return
    }

    this.clearAnalysisTimer()
    this.setData({
      tempFilePath,
      fileID: '',
      status: 'analyzing'
    }, () => {
      this.uploadRecording(tempFilePath)
    })
  },

  uploadRecording(tempFilePath) {
    if (this.uploadTask || !this.isPageActive) {
      return
    }

    const timestamp = Date.now()
    const randomString = Math.random().toString(36).slice(2, 10)
    const cloudPath = `recordings/${timestamp}-${randomString}.mp3`

    this.uploadTask = wx.cloud.uploadFile({
      cloudPath,
      filePath: tempFilePath,
      success: ({ fileID }) => {
        this.uploadTask = null
        console.log('录音云文件 ID:', fileID)

        if (!this.isPageActive) {
          return
        }

        this.setData({
          fileID
        })
        this.startAnalysisTimer()
      },
      fail: (error) => {
        this.uploadTask = null
        console.error('录音上传失败:', error)

        if (!this.isPageActive) {
          return
        }

        this.setData({
          status: 'idle',
          tempFilePath: '',
          fileID: ''
        })
        wx.showToast({
          title: '录音上传失败，请重试',
          icon: 'none'
        })
      }
    })
  },

  startAnalysisTimer() {
    this.clearAnalysisTimer()
    this.analysisTimer = setTimeout(() => {
      this.analysisTimer = null

      if (this.isPageActive) {
        this.setData({
          status: 'feedback'
        })
      }
    }, 1500)
  },

  onRecordError(error) {
    this.isRecording = false
    console.error('录音失败:', error)

    if (this.isPageActive) {
      this.setData({
        status: 'idle',
        tempFilePath: '',
        fileID: ''
      })
      wx.showToast({
        title: '录音失败，请重试',
        icon: 'none'
      })
    }
  },

  retryAnswer() {
    this.setData({
      status: 'idle',
      tempFilePath: '',
      fileID: ''
    })
  },

  completePractice() {
    this.clearAnalysisTimer()
    wx.navigateBack()
  },

  clearAnalysisTimer() {
    if (this.analysisTimer) {
      clearTimeout(this.analysisTimer)
      this.analysisTimer = null
    }
  },

  clearUploadTask() {
    if (this.uploadTask && this.uploadTask.abort) {
      const uploadTask = this.uploadTask
      this.uploadTask = null
      uploadTask.abort()
    }
  },

  clearRecorder() {
    if (!this.recorderManager) {
      return
    }

    if (this.recorderManager.offStop) {
      this.recorderManager.offStop(this.handleRecorderStop)
    }
    if (this.recorderManager.offError) {
      this.recorderManager.offError(this.handleRecorderError)
    }
    if (this.isRecording) {
      this.recorderManager.stop()
    }

    this.isRecording = false
    this.recorderManager = null
  },

  onUnload() {
    this.isPageActive = false
    this.clearAnalysisTimer()
    this.clearUploadTask()
    this.clearRecorder()
  }
})
