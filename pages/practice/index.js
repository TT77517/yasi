Page({
  data: {
    status: 'idle',
    tempFilePath: '',
    fileID: '',
    transcript: '',
    feedback: null
  },

  uploadTask: null,
  recognizingFileID: '',
  analyzingTranscript: '',
  recognitionRequestToken: 0,
  recorderManager: null,
  handleRecorderStop: null,
  handleRecorderError: null,
  isRecording: false,
  isPageActive: false,
  recordingFileIDs: null,
  cleanupRequestedFileIDs: null,

  onLoad() {
    this.isPageActive = true
    this.recordingFileIDs = new Set()
    this.cleanupRequestedFileIDs = new Set()
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
    if (!this.isPageActive || this.data.status !== 'idle') {
      return
    }

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
    if (
      !this.recorderManager ||
      !this.isPageActive ||
      this.data.status !== 'idle'
    ) {
      return
    }

    this.resetRecognitionRequest()
    this.recorderManager.start({
      duration: 60000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'mp3'
    })
    this.isRecording = true
    this.setData({
      status: 'recording',
      tempFilePath: '',
      fileID: '',
      transcript: '',
      feedback: null
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

    this.setData({
      tempFilePath,
      fileID: '',
      transcript: '',
      feedback: null,
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

        if (fileID && this.recordingFileIDs) {
          this.recordingFileIDs.add(fileID)
        }

        if (!this.isPageActive) {
          this.cleanupRecording(fileID)
          return
        }

        this.setData({
          fileID
        }, () => {
          this.recognizeSpeech(fileID)
        })
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
          fileID: '',
          transcript: '',
          feedback: null
        })
        wx.showToast({
          title: '录音上传失败，请重试',
          icon: 'none'
        })
      }
    })
  },

  async recognizeSpeech(fileID) {
    if (
      !this.isPageActive ||
      this.data.status !== 'analyzing' ||
      !fileID ||
      this.recognizingFileID === fileID
    ) {
      return
    }

    this.recognizingFileID = fileID
    const requestToken = ++this.recognitionRequestToken

    try {
      const response = await wx.cloud.callFunction({
        name: 'speechToText',
        data: {
          fileID
        }
      })

      if (
        !this.isPageActive ||
        requestToken !== this.recognitionRequestToken
      ) {
        return
      }

      const functionResult = response.result
      if (
        !functionResult ||
        functionResult.success !== true ||
        typeof functionResult.transcript !== 'string' ||
        !functionResult.transcript.trim()
      ) {
        const recognitionError = functionResult && functionResult.success === false
          ? {
              code: functionResult.code || 'STT_FAILED',
              message: functionResult.message || '语音识别失败',
              requestId: functionResult.requestId || ''
            }
          : {
              code: 'INVALID_STT_RESPONSE',
              message: '云函数返回无效的识别结果',
              response
            }

        this.handleRecognitionFailure(recognitionError)
        return
      }

      const transcript = functionResult.transcript.trim()
      const retainedFileID = typeof functionResult.fileID === 'string' && functionResult.fileID.trim()
        ? functionResult.fileID.trim()
        : fileID
      console.log('语音识别结果:', transcript)
      this.setData({
        transcript,
        fileID: retainedFileID
      }, () => {
        this.analyzeSpeaking(transcript, requestToken)
      })
    } catch (error) {
      if (
        this.isPageActive &&
        requestToken === this.recognitionRequestToken
      ) {
        this.handleRecognitionFailure(error)
      }
    }
  },

  handleRecognitionFailure(error) {
    console.error('语音识别失败:', error)

    if (!this.isPageActive) {
      return
    }

    this.setData({
      status: 'idle',
      tempFilePath: '',
      fileID: '',
      transcript: '',
      feedback: null
    })
    wx.showToast({
      title: '语音识别失败，请重试',
      icon: 'none'
    })
  },

  async analyzeSpeaking(transcript, requestToken) {
    if (
      !this.isPageActive ||
      this.data.status !== 'analyzing' ||
      !transcript ||
      requestToken !== this.recognitionRequestToken ||
      this.analyzingTranscript
    ) {
      return
    }

    this.analyzingTranscript = transcript

    try {
      const response = await wx.cloud.callFunction({
        name: 'analyzeSpeaking',
        data: {
          transcript
        }
      })

      if (
        !this.isPageActive ||
        requestToken !== this.recognitionRequestToken
      ) {
        return
      }

      const functionResult = response.result
      const feedback = functionResult && functionResult.feedback
      if (
        !functionResult ||
        functionResult.success !== true ||
        !feedback ||
        typeof feedback.overallFeedback !== 'string' ||
        !Array.isArray(feedback.grammarCorrections) ||
        !Array.isArray(feedback.vocabularySuggestions) ||
        typeof feedback.improvedAnswer !== 'string' ||
        typeof feedback.nextTip !== 'string'
      ) {
        this.handleAnalysisFailure({
          message: '云函数返回无效的 AI 分析结果',
          response
        })
        return
      }

      console.log('AI 分析结果:', feedback)
      this.setData({
        feedback,
        status: 'feedback'
      })
    } catch (error) {
      if (
        this.isPageActive &&
        requestToken === this.recognitionRequestToken
      ) {
        this.handleAnalysisFailure(error)
      }
    } finally {
      if (requestToken === this.recognitionRequestToken) {
        this.analyzingTranscript = ''
      }
    }
  },

  handleAnalysisFailure(error) {
    console.error('AI 分析失败:', error)

    if (!this.isPageActive) {
      return
    }

    this.setData({
      status: 'idle',
      tempFilePath: '',
      fileID: '',
      transcript: '',
      feedback: null
    })
    wx.showToast({
      title: 'AI 分析失败，请重试',
      icon: 'none'
    })
  },

  onRecordError(error) {
    this.isRecording = false
    console.error('录音失败:', error)

    if (this.isPageActive) {
      this.setData({
        status: 'idle',
        tempFilePath: '',
        fileID: '',
        transcript: '',
        feedback: null
      })
      wx.showToast({
        title: '录音失败，请重试',
        icon: 'none'
      })
    }
  },

  retryAnswer() {
    this.resetRecognitionRequest()
    this.setData({
      status: 'idle',
      tempFilePath: '',
      fileID: '',
      transcript: '',
      feedback: null
    })
  },

  completePractice() {
    this.cleanupPracticeRecordings()
    this.resetRecognitionRequest()
    wx.navigateBack()
  },

  cleanupPracticeRecordings() {
    const fileIDs = new Set(this.recordingFileIDs || [])

    if (this.data.fileID) {
      fileIDs.add(this.data.fileID)
    }

    fileIDs.forEach((fileID) => {
      this.cleanupRecording(fileID)
    })
  },

  cleanupRecording(fileID) {
    const normalizedFileID = typeof fileID === 'string' ? fileID.trim() : ''

    if (!normalizedFileID) {
      return
    }

    if (!this.cleanupRequestedFileIDs) {
      this.cleanupRequestedFileIDs = new Set()
    }

    if (this.cleanupRequestedFileIDs.has(normalizedFileID)) {
      return
    }

    this.cleanupRequestedFileIDs.add(normalizedFileID)
    wx.cloud.callFunction({
      name: 'cleanupRecording',
      data: {
        fileID: normalizedFileID
      }
    }).then(({ result }) => {
      if (!result || result.success !== true) {
        console.error('录音清理失败', {
          fileID: normalizedFileID,
          message: (result && result.message) || '云函数返回无效结果'
        })
      }
    }).catch((error) => {
      console.error('录音清理调用失败', {
        fileID: normalizedFileID,
        code: error && error.code,
        message: error && error.message
      })
    })
  },

  clearUploadTask() {
    if (this.uploadTask && this.uploadTask.abort) {
      const uploadTask = this.uploadTask
      this.uploadTask = null
      uploadTask.abort()
    }
  },

  resetRecognitionRequest() {
    this.recognitionRequestToken += 1
    this.recognizingFileID = ''
    this.analyzingTranscript = ''
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
    this.cleanupPracticeRecordings()
    this.isPageActive = false
    this.clearUploadTask()
    this.resetRecognitionRequest()
    this.clearRecorder()
  }
})
