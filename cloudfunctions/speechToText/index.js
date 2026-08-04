const https = require('https')
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1'
const DEFAULT_MODEL = 'paraformer-v2'
const POLL_INTERVAL_MS = 1000
const MAX_POLL_ATTEMPTS = 40
const REQUEST_TIMEOUT_MS = 15000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024

function createError(code, message, requestId = '') {
  const error = new Error(message)
  error.code = code
  error.requestId = requestId
  return error
}

function getConfig() {
  const apiKey = (process.env.DASHSCOPE_API_KEY || '').trim()
  const baseUrl = (process.env.DASHSCOPE_BASE_URL || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '')
  const model = (process.env.DASHSCOPE_ASR_MODEL || DEFAULT_MODEL).trim()

  if (!apiKey || !baseUrl || !model) {
    return null
  }

  let parsedBaseUrl
  try {
    parsedBaseUrl = new URL(baseUrl)
  } catch (error) {
    throw createError('INVALID_DASHSCOPE_CONFIG', '阿里云百炼接口地址无效')
  }

  if (parsedBaseUrl.protocol !== 'https:') {
    throw createError('INVALID_DASHSCOPE_CONFIG', '阿里云百炼接口必须使用 HTTPS')
  }

  return { apiKey, baseUrl, model }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function parseResponseBody(responseText) {
  if (!responseText.trim()) {
    return {}
  }

  try {
    return JSON.parse(responseText)
  } catch (error) {
    throw createError('INVALID_DASHSCOPE_RESPONSE', '阿里云语音识别返回格式不正确')
  }
}

function getResponseError(statusCode, responseBody) {
  const output = responseBody && responseBody.output
  const code = responseBody.code || (output && output.code) || `HTTP_${statusCode}`
  const message = responseBody.message ||
    (output && output.message) ||
    `阿里云语音识别请求失败（HTTP ${statusCode}）`

  return createError(code, message, responseBody.request_id || '')
}

function requestJson(url, options = {}, redirectCount = 0) {
  const method = options.method || 'GET'
  const body = options.body ? JSON.stringify(options.body) : ''
  const headers = {
    ...(options.headers || {})
  }

  if (body) {
    headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = Buffer.byteLength(body)
  }

  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers }, (response) => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location &&
        redirectCount < 3
      ) {
        response.resume()
        const redirectUrl = new URL(response.headers.location, url)
        resolve(requestJson(redirectUrl, options, redirectCount + 1))
        return
      }

      const chunks = []
      let totalBytes = 0

      response.on('data', (chunk) => {
        totalBytes += chunk.length
        if (totalBytes > MAX_RESPONSE_BYTES) {
          response.destroy(
            createError('DASHSCOPE_RESPONSE_TOO_LARGE', '阿里云语音识别响应过大')
          )
          return
        }
        chunks.push(chunk)
      })

      response.on('error', reject)
      response.on('end', () => {
        let responseBody
        try {
          responseBody = parseResponseBody(Buffer.concat(chunks).toString('utf8'))
        } catch (error) {
          reject(error)
          return
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(getResponseError(response.statusCode || 0, responseBody))
          return
        }

        resolve(responseBody)
      })
    })

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(createError('DASHSCOPE_REQUEST_TIMEOUT', '阿里云语音识别请求超时'))
    })
    request.on('error', reject)
    request.end(body)
  })
}

async function getAudioUrl(fileID) {
  const result = await cloud.getTempFileURL({
    fileList: [fileID]
  })
  const file = result.fileList && result.fileList[0]

  if (!file || file.status !== 0 || !file.tempFileURL) {
    throw createError(
      'AUDIO_URL_FAILED',
      (file && file.errMsg) || '无法获取录音文件临时地址'
    )
  }

  return file.tempFileURL
}

async function submitTranscription(audioUrl, config) {
  const parameters = {
    channel_id: [0]
  }

  if (config.model === 'paraformer-v2') {
    parameters.language_hints = ['en']
  }

  const response = await requestJson(
    `${config.baseUrl}/services/audio/asr/transcription`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'X-DashScope-Async': 'enable'
      },
      body: {
        model: config.model,
        input: {
          file_urls: [audioUrl]
        },
        parameters
      }
    }
  )

  const taskId = response.output && response.output.task_id
  if (!taskId) {
    throw createError(
      response.code || 'INVALID_DASHSCOPE_RESPONSE',
      response.message || '阿里云语音识别未返回任务 ID',
      response.request_id || ''
    )
  }

  return {
    taskId,
    requestId: response.request_id || ''
  }
}

async function waitForTranscription(taskId, config) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    await delay(POLL_INTERVAL_MS)

    const response = await requestJson(
      `${config.baseUrl}/tasks/${encodeURIComponent(taskId)}`,
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`
        }
      }
    )
    const output = response.output || {}
    const status = output.task_status

    if (typeof status !== 'string' || !status) {
      throw createError(
        'INVALID_DASHSCOPE_RESPONSE',
        '阿里云语音识别未返回任务状态',
        response.request_id || ''
      )
    }

    if (status === 'SUCCEEDED') {
      return response
    }

    if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(status)) {
      throw createError(
        output.code || `DASHSCOPE_TASK_${status || 'FAILED'}`,
        output.message || '阿里云语音识别任务失败',
        response.request_id || ''
      )
    }
  }

  throw createError('DASHSCOPE_TASK_TIMEOUT', '阿里云语音识别任务处理超时')
}

function getTranscriptionUrl(taskResponse) {
  const output = taskResponse.output || {}
  const results = Array.isArray(output.results) ? output.results : []
  const completedResult = results.find((item) => item && item.transcription_url)

  if (!completedResult) {
    const failedResult = results.find((item) => item && item.code)
    throw createError(
      (failedResult && failedResult.code) || 'INVALID_DASHSCOPE_RESPONSE',
      (failedResult && failedResult.message) || '阿里云语音识别未返回结果地址',
      taskResponse.request_id || ''
    )
  }

  return completedResult.transcription_url
}

async function readTranscript(transcriptionUrl) {
  const result = await requestJson(transcriptionUrl)
  const transcripts = Array.isArray(result.transcripts) ? result.transcripts : []
  const transcript = transcripts
    .map((item) => (item && typeof item.text === 'string' ? item.text.trim() : ''))
    .filter(Boolean)
    .join(' ')
    .trim()

  if (!transcript) {
    throw createError('EMPTY_TRANSCRIPT', '未识别到有效的英文语音')
  }

  return transcript
}

async function cleanupRecording(fileID) {
  try {
    await cloud.deleteFile({
      fileList: [fileID]
    })
    return true
  } catch (error) {
    console.error('speechToText cleanup failed', {
      fileID,
      code: error && error.code,
      message: error && error.message
    })
    return false
  }
}

exports.main = async (event = {}) => {
  const fileID = typeof event.fileID === 'string' ? event.fileID.trim() : ''

  if (!fileID) {
    return {
      success: false,
      code: 'MISSING_FILE_ID',
      message: '缺少录音文件 ID',
      cleanup: {
        attempted: false,
        deleted: false
      }
    }
  }

  let config
  try {
    config = getConfig()
  } catch (error) {
    return {
      success: false,
      code: error.code,
      message: error.message,
      cleanup: {
        attempted: false,
        deleted: false
      }
    }
  }

  if (!config) {
    return {
      success: false,
      code: 'MISSING_DASHSCOPE_CONFIG',
      message: '云函数未配置阿里云百炼 API Key',
      cleanup: {
        attempted: false,
        deleted: false
      }
    }
  }

  try {
    const audioUrl = await getAudioUrl(fileID)
    const submission = await submitTranscription(audioUrl, config)
    const taskResponse = await waitForTranscription(submission.taskId, config)
    const transcriptionUrl = getTranscriptionUrl(taskResponse)
    const transcript = await readTranscript(transcriptionUrl)

    return {
      success: true,
      transcript,
      fileID,
      requestId: taskResponse.request_id || submission.requestId,
      cleanup: {
        attempted: false,
        deleted: false
      }
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
      message: error.message || '语音识别失败',
      requestId: error.requestId || '',
      cleanup: {
        attempted: false,
        deleted: false
      }
    }
  }
}
