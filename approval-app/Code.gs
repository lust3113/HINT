/**
 * 승인 위임 앱 (실험용) - Code.gs (Vercel 연동 우회 버전)
 */

var SHEET_LOG = '처리기록';
var SHEET_CONFIG = '설정';
var TIME_ZONE = 'Asia/Seoul';
var IMPORTANCE_LIST = ['상', '중', '하'];

var LOG_HEADERS = [
  '접수번호', '접수시각', '제목', '신청자', '금액', '내용',
  '중요도', '판정', '처리', '사유'
];

var DEFAULT_CONFIG_ROWS = [
  ['금액한도', 1000000, '이 금액을 넘으면 보류 (원)'],
  ['관리자이메일', '', '알림 받을 이메일. 비우면 이 스크립트를 만든 사람에게 보냅니다'],
  ['금지키워드', '도박,불법,뇌물,리베이트', '제목/내용에 포함되면 반려 (쉼표로 구분)'],
  ['주의키워드', '긴급,선지급,현금,외부 송금', '제목/내용에 포함되면 보류 (쉼표로 구분)']
];

/* ------------------------------------------------------------------ */
/* 웹앱 진입점 및 외부 요청(POST) 처리                                     */
/* ------------------------------------------------------------------ */

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('승인 위임 앱')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Vercel(외부)에서 보내는 fetch 요청을 처리하는 우회 통로 */
function doPost(e) {
  try {
    var contents = e.postData.contents;
    var payload = JSON.parse(contents);
    var action = payload.action;
    var result;

    if (action === 'submitRequest') {
      result = submitRequest(payload.form);
    } else if (action === 'getRecent') {
      result = getRecent(payload.limit);
    } else if (action === 'getAppInfo') {
      result = getAppInfo();
    } else {
      result = { error: '알 수 없는 요청입니다.' };
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function setup() {
  ensureSheets_();
  var admin = getAdminEmail_(loadConfig_());
  Logger.log('설정 완료. 관리자 알림 주소: ' + admin);
  return '설정 완료. 관리자 알림 주소: ' + admin;
}

/* ------------------------------------------------------------------ */
/* 비즈니스 로직 함수들                                                */
/* ------------------------------------------------------------------ */

function getAppInfo() {
  var cfg = loadConfig_();
  return { amountLimit: cfg.amountLimit };
}

function submitRequest(form) {
  var cfg = loadConfig_();
  var req = normalizeRequest_(form);
  var verdict = evaluateRequest_(req, cfg);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var receiptNo;
  try {
    var sheet = ensureSheets_().log;
    receiptNo = nextReceiptNo_(sheet);
    sheet.appendRow([
      receiptNo,
      Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'),
      req.title,
      req.applicant,
      req.amountText,
      req.content,
      req.importance,
      verdict.result,
      verdict.handling,
      verdict.reasons.join(' / ')
    ]);
  } finally {
    lock.releaseLock();
  }

  var notified = false;
  if (verdict.toAdmin) {
    notified = notifyAdmin_(receiptNo, req, verdict, cfg);
  }

  return {
    receiptNo: receiptNo,
    result: verdict.result,
    handling: verdict.handling,
    reasons: verdict.reasons,
    toAdmin: verdict.toAdmin,
    notified: notified
  };
}

function getRecent(limit) {
  limit = limit || 10;
  var sheet = ensureSheets_().log;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var count = Math.min(limit, lastRow - 1);
  var rows = sheet.getRange(lastRow - count + 1, 1, count, LOG_HEADERS.length).getDisplayValues();
  return rows.reverse().map(function (r) {
    return {
      receiptNo: r[0], time: r[1], title: r[2], applicant: r[3],
      amount: r[4], importance: r[6], result: r[7], handling: r[8]
    };
  });
}

function normalizeRequest_(form) {
  form = form || {};
  var amountText = String(form.amount === undefined || form.amount === null ? '' : form.amount)
    .replace(/[,\s원]/g, '');
  var amount = amountText === '' ? NaN : Number(amountText);
  return {
    title: String(form.title || '').trim(),
    applicant: String(form.applicant || '').trim(),
    content: String(form.content || '').trim(),
    importance: String(form.importance || '').trim(),
    amountText: amountText,
    amount: amount
  };
}

function squash_(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

function splitKeywords_(text) {
  return String(text || '')
    .split(',')
    .map(function (k) { return k.trim(); })
    .filter(function (k) { return k !== ''; });
}

function findKeywords_(text, keywords) {
  var target = squash_(text);
  return keywords.filter(function (k) {
    return target.indexOf(squash_(k)) !== -1;
  });
}

function evaluateRequest_(req, cfg) {
  var banned = [];
  var hold = [];
  var text = req.title + ' ' + req.content;

  var bannedHits = findKeywords_(text, cfg.bannedKeywords);
  if (bannedHits.length > 0) {
    banned.push('금지 키워드 포함: ' + bannedHits.join(', '));
  }

  var missing = [];
  if (!req.title) missing.push('제목');
  if (!req.applicant) missing.push('신청자');
  if (!req.content) missing.push('내용');
  if (!req.amountText) missing.push('금액');
  if (missing.length > 0) hold.push('필수 항목 누락: ' + missing.join(', '));

  if (req.amountText && (isNaN(req.amount) || req.amount < 0)) {
    hold.push('금액 형식 오류: 0 이상의 숫자만 입력');
  }
  if (IMPORTANCE_LIST.indexOf(req.importance) === -1) {
    hold.push('중요도 미선택: 상, 중, 하 중 선택');
  }

  if (!isNaN(req.amount) && req.amount > cfg.amountLimit) {
    hold.push('금액 한도 초과: ' + formatWon_(req.amount) + ' > ' + formatWon_(cfg.amountLimit));
  }

  var cautionHits = findKeywords_(text, cfg.cautionKeywords);
  if (cautionHits.length > 0) {
    hold.push('주의 키워드 포함: ' + cautionHits.join(', '));
  }

  if (banned.length > 0) {
    return {
      result: '반려',
      handling: '관리자 전송',
      toAdmin: true,
      reasons: banned.concat(hold)
    };
  }
  if (hold.length > 0) {
    return {
      result: '보류',
      handling: '관리자 전송',
      toAdmin: true,
      reasons: hold
    };
  }

  if (req.importance === '상' || req.importance === '중') {
    return {
      result: '승인',
      handling: '관리자 확인 대기',
      toAdmin: true,
      reasons: ['기준 통과 (중요도 ' + req.importance + ': 관리자에게 전송)']
    };
  }
  return {
    result: '승인',
    handling: '자동 승인 완료',
    toAdmin: false,
    reasons: ['기준 통과 (중요도 하: 자동 승인)']
  };
}

function formatWon_(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';
}

function ensureSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var log = ss.getSheetByName(SHEET_LOG);
  if (!log) {
    log = ss.insertSheet(SHEET_LOG);
    log.appendRow(LOG_HEADERS);
    log.setFrozenRows(1);
    log.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight('bold');
  }

  var config = ss.getSheetByName(SHEET_CONFIG);
  if (!config) {
    config = ss.insertSheet(SHEET_CONFIG);
    config.appendRow(['이름', '값', '설명']);
    DEFAULT_CONFIG_ROWS.forEach(function (row) { config.appendRow(row); });
    config.getRange(1, 1, 1, 3).setFontWeight('bold');
    config.setColumnWidth(1, 120);
    config.setColumnWidth(2, 320);
    config.setColumnWidth(3, 420);
  }
  return { log: log, config: config };
}

function loadConfig_() {
  var sheet = ensureSheets_().config;
  var map = {};
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 2).getValues().forEach(function (r) {
      map[String(r[0]).trim()] = r[1];
    });
  }
  var limit = Number(String(map['금액한도']).replace(/[,\s원]/g, ''));
  if (isNaN(limit) || map['금액한도'] === '' || map['금액한도'] === undefined) {
    limit = DEFAULT_CONFIG_ROWS[0][1];
  }
  return {
    amountLimit: limit,
    adminEmail: String(map['관리자이메일'] || '').trim(),
    bannedKeywords: splitKeywords_(map['금지키워드']),
    cautionKeywords: splitKeywords_(map['주의키워드'])
  };
}

function getAdminEmail_(cfg) {
  if (cfg.adminEmail) return cfg.adminEmail;
  return Session.getEffectiveUser().getEmail();
}

function nextReceiptNo_(logSheet) {
  var seq = Math.max(logSheet.getLastRow(), 1);
  var date = Utilities.formatDate(new Date(), TIME_ZONE, 'yyMMdd');
  return 'R-' + date + '-' + ('000' + seq).slice(-3);
}

function notifyAdmin_(receiptNo, req, verdict, cfg) {
  try {
    var to = getAdminEmail_(cfg);
    if (!to) return false;
    var subject = '[승인 앱] ' + verdict.result + ' (' + verdict.handling + ') - ' + req.title;
    var body = [
      '접수번호: ' + receiptNo,
      '판정: ' + verdict.result + ' / 처리: ' + verdict.handling,
      '중요도: ' + req.importance,
      '신청자: ' + req.applicant,
      '금액: ' + (isNaN(req.amount) ? req.amountText : formatWon_(req.amount)),
      '제목: ' + req.title,
      '내용: ' + req.content,
      '',
      '사유:',
      verdict.reasons.map(function (r) { return '- ' + r; }).join('\n'),
      '',
      '전체 기록은 스프레드시트의 "' + SHEET_LOG + '" 시트에서 볼 수 있습니다.'
    ].join('\n');
    MailApp.sendEmail(to, subject, body);
    return true;
  } catch (e) {
    Logger.log('알림 발송 실패: ' + e);
    return false;
  }
}
