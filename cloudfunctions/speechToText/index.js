const https = require('https')
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1'
const DEFAULT_MODEL = 'paraformer-v2'
const POLL_INTERVAL_MS = 1500
const MAX_POLL_WAIT_MS = 45000
const REQUEST_TIMEOUT_MS = 15000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024

function createError(code, message, requestId = '') {
  const error = new Error(message)
  error.code = code
  error.requestId = requestId
  return error
}

function logSpeechToTextError(error) {
  console.error('speechToText 识别失败', {
    code: error && error.code,
    message: error && error.message,
    requestId: (error && error.requestId) || ''
  })
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

  let response
  try {
    response = await requestJson(
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
  } catch (error) {
    if (error.code === 'INVALID_DASHSCOPE_RESPONSE') {
      throw createError(
        'INVALID_STT_RESPONSE',
        error.message,
        error.requestId || ''
      )
    }

    throw createError(
      'STT_SUBMIT_FAILED',
      error.message || '语音识别任务提交失败',
      error.requestId || ''
    )
  }

  const taskId = response.output && response.output.task_id
  if (!taskId) {
    throw createError(
      'INVALID_STT_RESPONSE',
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
  const pollingStartedAt = Date.now()
  let pollNumber = 0

  while (Date.now() - pollingStartedAt < MAX_POLL_WAIT_MS) {
    const elapsedMs = Date.now() - pollingStartedAt
    const remainingMs = MAX_POLL_WAIT_MS - elapsedMs
    await delay(Math.min(POLL_INTERVAL_MS, remainingMs))

    if (Date.now() - pollingStartedAt >= MAX_POLL_WAIT_MS) {
      break
    }

    pollNumber += 1
    let response
    try {
      response = await requestJson(
        `${config.baseUrl}/tasks/${encodeURIComponent(taskId)}`,
        {
          headers: {
            Authorization: `Bearer ${config.apiKey}`
          }
        }
      )
    } catch (error) {
      if (error.code === 'INVALID_DASHSCOPE_RESPONSE') {
        throw createError(
          'INVALID_STT_RESPONSE',
          error.message,
          error.requestId || ''
        )
      }

      throw createError(
        'STT_QUERY_FAILED',
        error.message || '语音识别任务查询失败',
        error.requestId || ''
      )
    }

    const output = response.output || {}
    const status = output.task_status

    if (typeof status !== 'string' || !status) {
      throw createError(
        'INVALID_STT_RESPONSE',
        '阿里云语音识别未返回任务状态',
        response.request_id || ''
      )
    }

    const taskStatus = status.toUpperCase()
    console.log('speechToText 轮询状态', {
      taskId,
      pollNumber,
      taskStatus
    })

    if (taskStatus === 'SUCCEEDED') {
      return response
    }

    if (taskStatus === 'FAILED') {
      const results = Array.isArray(output.results) ? output.results : []
      const failedResult = results.find(
        (item) => item && (item.subtask_status === 'FAILED' || item.code)
      )
      throw createError(
        (failedResult && failedResult.code) || output.code || 'STT_QUERY_FAILED',
        (failedResult && failedResult.message) || output.message || '阿里云语音识别任务失败',
        response.request_id || ''
      )
    }

    if (!['PENDING', 'RUNNING'].includes(taskStatus)) {
      throw createError(
        'INVALID_STT_RESPONSE',
        `阿里云语音识别返回未知任务状态：${taskStatus}`,
        response.request_id || ''
      )
    }
  }

  throw createError('STT_TIMEOUT', '语音识别处理超时，请重试')
}

function getTranscriptionUrl(taskResponse) {
  const output = taskResponse.output || {}
  const results = Array.isArray(output.results) ? output.results : []
  const completedResult = results.find((item) => item && item.transcription_url)

  if (!completedResult) {
    const failedResult = results.find((item) => item && item.code)
    throw createError(
      (failedResult && failedResult.code) || 'INVALID_STT_RESPONSE',
      (failedResult && failedResult.message) || '阿里云语音识别未返回结果地址',
      taskResponse.request_id || ''
    )
  }

  return completedResult.transcription_url
}

function extractTextSegments(value) {
  if (typeof value === 'string') {
    const text = value.trim()
    return text ? [text] : []
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextSegments(item))
  }

  if (!value || typeof value !== 'object') {
    return []
  }

  const collectionKeys = [
    'transcriptions',
    'transcription',
    'transcripts',
    'paragraphs',
    'paragraph',
    'sentences',
    'sentence'
  ]

  for (const key of collectionKeys) {
    if (value[key] === undefined || value[key] === null) {
      continue
    }

    const segments = extractTextSegments(value[key])
    if (segments.length > 0) {
      return segments
    }
  }

  const wrapperKeys = ['results', 'result', 'output', 'data']
  for (const key of wrapperKeys) {
    if (value[key] === undefined || value[key] === null) {
      continue
    }

    const segments = extractTextSegments(value[key])
    if (segments.length > 0) {
      return segments
    }
  }

  const textKeys = ['text', 'transcript', 'content']
  for (const key of textKeys) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return [value[key].trim()]
    }
  }

  return []
}

async function readTranscript(transcriptionUrl) {
  let result
  try {
    result = await requestJson(transcriptionUrl)
  } catch (error) {
    if (error.code === 'INVALID_DASHSCOPE_RESPONSE') {
      throw createError(
        'INVALID_STT_RESPONSE',
        error.message,
        error.requestId || ''
      )
    }

    throw createError(
      'STT_QUERY_FAILED',
      error.message || '语音识别结果读取失败',
      error.requestId || ''
    )
  }

  const transcript = extractTextSegments(result)
    .join(' ')
    .replace(/\s+/g, ' ')
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
  console.log('speechToText 收到请求', {
    hasFileID: Boolean(fileID)
  })

  if (!fileID) {
    logSpeechToTextError({
      code: 'MISSING_FILE_ID',
      message: '缺少录音文件 ID'
    })
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
    logSpeechToTextError(error)
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
    logSpeechToTextError({
      code: 'MISSING_DASHSCOPE_CONFIG',
      message: '云函数未配置阿里云百炼 API Key'
    })
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
    console.log('speechToText 音频临时地址已生成', {
      hasFileID: true,
      audioUrlGenerated: true
    })

    const submittedAt = Date.now()
    const submission = await submitTranscription(audioUrl, config)
    console.log('speechToText 任务提交成功', {
      taskId: submission.taskId
    })

    const taskResponse = await waitForTranscription(submission.taskId, config)
    console.log('speechToText 任务完成', {
      taskId: submission.taskId,
      elapsedMs: Date.now() - submittedAt
    })

    const transcriptionUrl = getTranscriptionUrl(taskResponse)
    const transcript = await readTranscript(transcriptionUrl)
    console.log('speechToText 文本提取完成', {
      taskId: submission.taskId,
      transcriptLength: transcript.length
    })

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
    logSpeechToTextError(error)

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
