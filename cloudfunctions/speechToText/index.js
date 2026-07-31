const cloud = require('wx-server-sdk')
const tencentcloud = require('tencentcloud-sdk-nodejs')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const AsrClient = tencentcloud.asr.v20190614.Client

exports.main = async (event = {}) => {
  const { fileID } = event

  if (!fileID) {
    return {
      success: false,
      code: 'MISSING_FILE_ID',
      message: '缺少录音文件 ID'
    }
  }

  const secretId = process.env.TENCENT_SECRET_ID
  const secretKey = process.env.TENCENT_SECRET_KEY

  if (!secretId || !secretKey) {
    return {
      success: false,
      code: 'MISSING_CREDENTIALS',
      message: '云函数未配置腾讯云密钥'
    }
  }

  try {
    const downloadResult = await cloud.downloadFile({
      fileID
    })
    const audioBuffer = Buffer.isBuffer(downloadResult.fileContent)
      ? downloadResult.fileContent
      : Buffer.from(downloadResult.fileContent)

    const client = new AsrClient({
      credential: {
        secretId,
        secretKey
      },
      region: 'ap-guangzhou',
      profile: {
        httpProfile: {
          endpoint: 'asr.tencentcloudapi.com'
        }
      }
    })

    const response = await client.SentenceRecognition({
      ProjectId: 0,
      SubServiceType: 2,
      // 腾讯云当前文档将 16k_en 定义为非电话场景的英语 16k 引擎。
      EngSerViceType: '16k_en',
      SourceType: 1,
      VoiceFormat: 'mp3',
      Data: audioBuffer.toString('base64'),
      DataLen: audioBuffer.length
    })

    return {
      success: true,
      transcript: response.Result || '',
      requestId: response.RequestId || ''
    }
  } catch (error) {
    console.error('speechToText 识别失败', {
      code: error.code,
      message: error.message,
      requestId: error.requestId
    })

    return {
      success: false,
      code: error.code || 'STT_FAILED',
      message: error.message || '语音识别失败'
    }
  }
}
