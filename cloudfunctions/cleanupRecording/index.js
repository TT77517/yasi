const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

exports.main = async (event = {}) => {
  const fileID = typeof event.fileID === 'string' ? event.fileID.trim() : ''

  if (!fileID) {
    return {
      success: false,
      message: '缺少录音文件 ID'
    }
  }

  try {
    const result = await cloud.deleteFile({
      fileList: [fileID]
    })
    const deletedFile = result && Array.isArray(result.fileList)
      ? result.fileList[0]
      : null

    if (deletedFile && deletedFile.status !== 0) {
      const error = new Error(deletedFile.errMsg || '录音清理失败')
      error.code = deletedFile.status
      throw error
    }

    return {
      success: true
    }
  } catch (error) {
    console.error('cleanupRecording 删除失败', {
      fileID,
      code: error && error.code,
      message: error && error.message
    })

    return {
      success: false,
      message: (error && error.message) || '录音清理失败'
    }
  }
}
