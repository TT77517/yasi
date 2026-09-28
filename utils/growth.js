const GROWTH_STORAGE_KEY = 'speakease_growth_v1'
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

function createDefaultGrowthData() {
  return {
    totalPracticeCount: 0,
    totalPracticeSeconds: 0,
    dailyRecords: {},
    streak: 0,
    lastPracticeDate: '',
    latestTip: ''
  }
}

function toNonNegativeInteger(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) {
    return 0
  }
  return Math.floor(number)
}

function toSafeText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function isValidDateKey(dateKey) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return false
  }

  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return (
    Number.isFinite(date.getTime()) &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  )
}

function getLocalDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return ''
  }

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateKeyToDayNumber(dateKey) {
  if (!isValidDateKey(dateKey)) {
    return null
  }

  const [year, month, day] = dateKey.split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY)
}

function sanitizeDailyRecord(record) {
  const source = record && typeof record === 'object' && !Array.isArray(record)
    ? record
    : {}

  return {
    practiceCount: toNonNegativeInteger(source.practiceCount),
    practiceSeconds: toNonNegativeInteger(source.practiceSeconds),
    latestTip: toSafeText(source.latestTip, 500),
    latestTopic: toSafeText(source.latestTopic, 100),
    latestQuestion: toSafeText(source.latestQuestion, 300)
  }
}

function sanitizeGrowthData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createDefaultGrowthData()
  }

  const dailyRecords = {}
  const sourceDailyRecords = value.dailyRecords &&
    typeof value.dailyRecords === 'object' &&
    !Array.isArray(value.dailyRecords)
    ? value.dailyRecords
    : {}

  Object.keys(sourceDailyRecords).forEach((dateKey) => {
    if (!isValidDateKey(dateKey)) {
      return
    }
    dailyRecords[dateKey] = sanitizeDailyRecord(sourceDailyRecords[dateKey])
  })

  return {
    totalPracticeCount: toNonNegativeInteger(value.totalPracticeCount),
    totalPracticeSeconds: toNonNegativeInteger(value.totalPracticeSeconds),
    dailyRecords,
    streak: toNonNegativeInteger(value.streak),
    lastPracticeDate: isValidDateKey(value.lastPracticeDate)
      ? value.lastPracticeDate
      : '',
    latestTip: toSafeText(value.latestTip, 500)
  }
}

function calculateStreak(dailyRecords, referenceDate = new Date()) {
  const todayKey = getLocalDateKey(referenceDate)
  const todayNumber = dateKeyToDayNumber(todayKey)
  if (todayNumber === null) {
    return 0
  }

  const practicedDays = new Set()
  const records = dailyRecords && typeof dailyRecords === 'object'
    ? dailyRecords
    : {}

  Object.keys(records).forEach((dateKey) => {
    const dayNumber = dateKeyToDayNumber(dateKey)
    const record = sanitizeDailyRecord(records[dateKey])
    if (
      dayNumber !== null &&
      dayNumber <= todayNumber &&
      record.practiceCount > 0
    ) {
      practicedDays.add(dayNumber)
    }
  })

  if (practicedDays.size === 0) {
    return 0
  }

  const latestPracticeDay = Math.max(...practicedDays)
  if (todayNumber - latestPracticeDay > 1) {
    return 0
  }

  let streak = 0
  let dayNumber = latestPracticeDay
  while (practicedDays.has(dayNumber)) {
    streak += 1
    dayNumber -= 1
  }

  return streak
}

function readGrowthData() {
  try {
    const storedValue = wx.getStorageSync(GROWTH_STORAGE_KEY)
    const data = sanitizeGrowthData(storedValue)
    data.streak = calculateStreak(data.dailyRecords)
    return data
  } catch (error) {
    console.error('Growth 数据读取失败', {
      message: error && error.message
    })
    return createDefaultGrowthData()
  }
}

function saveGrowthData(value, referenceDate = new Date()) {
  const data = sanitizeGrowthData(value)
  data.streak = calculateStreak(data.dailyRecords, referenceDate)

  try {
    wx.setStorageSync(GROWTH_STORAGE_KEY, data)
    return true
  } catch (error) {
    console.error('Growth 数据保存失败', {
      message: error && error.message
    })
    return false
  }
}

function recordCompletedPractice(record = {}, referenceDate = new Date()) {
  const dateKey = isValidDateKey(record.date)
    ? record.date
    : getLocalDateKey(referenceDate)

  if (!dateKey) {
    return {
      success: false,
      data: readGrowthData()
    }
  }

  const data = readGrowthData()
  const dailyRecord = sanitizeDailyRecord(data.dailyRecords[dateKey])
  const practiceSeconds = toNonNegativeInteger(record.practiceSeconds)
  const latestTip = toSafeText(record.nextTip, 500)

  dailyRecord.practiceCount += 1
  dailyRecord.practiceSeconds += practiceSeconds
  dailyRecord.latestTip = latestTip
  dailyRecord.latestTopic = toSafeText(record.topic, 100)
  dailyRecord.latestQuestion = toSafeText(record.question, 300)

  data.dailyRecords[dateKey] = dailyRecord
  data.totalPracticeCount += 1
  data.totalPracticeSeconds += practiceSeconds
  data.lastPracticeDate = dateKey
  data.latestTip = latestTip
  data.streak = calculateStreak(data.dailyRecords, referenceDate)

  return {
    success: saveGrowthData(data, referenceDate),
    data
  }
}

function formatPracticeMinutes(practiceSeconds) {
  const seconds = toNonNegativeInteger(practiceSeconds)
  if (seconds === 0) {
    return '0'
  }
  if (seconds < 60) {
    return '不到 1'
  }
  return String(Math.floor(seconds / 60))
}

function getTodaySummary(referenceDate = new Date()) {
  const data = readGrowthData()
  const dateKey = getLocalDateKey(referenceDate)
  const dailyRecord = sanitizeDailyRecord(data.dailyRecords[dateKey])

  return {
    date: dateKey,
    practiceCount: dailyRecord.practiceCount,
    practiceSeconds: dailyRecord.practiceSeconds,
    practiceMinutes: Math.floor(dailyRecord.practiceSeconds / 60),
    practiceMinutesText: formatPracticeMinutes(dailyRecord.practiceSeconds),
    streak: calculateStreak(data.dailyRecords, referenceDate),
    latestTip: dailyRecord.latestTip,
    latestTopic: dailyRecord.latestTopic,
    latestQuestion: dailyRecord.latestQuestion
  }
}

module.exports = {
  GROWTH_STORAGE_KEY,
  createDefaultGrowthData,
  readGrowthData,
  saveGrowthData,
  recordCompletedPractice,
  getTodaySummary,
  calculateStreak,
  formatPracticeMinutes,
  getLocalDateKey
}
