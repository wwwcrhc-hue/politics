'use strict';

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createReportsService({ reportsRepository, cleanText, makeId, now, rowTime, logModeration }) {
  async function createReport(userId, body) {
    await reportsRepository.createReport({
      id: makeId('r'),
      reporterId: userId,
      targetType: cleanText(body.targetType, 20),
      targetId: cleanText(body.targetId, 80),
      reason: cleanText(body.reason, 500),
      status: 'open',
      createdAt: now()
    });
    return { ok: true };
  }

  async function listReports() {
    const rows = await reportsRepository.listReports();
    return rows.map(r => ({ id:r.id, targetType:r.target_type, targetId:r.target_id, reason:r.reason, status:r.status, createdAt:rowTime(r.created_at), reporter:{ username:r.username, displayName:r.display_name } }));
  }

  async function updateReportStatus(actorUserId, reportId, body) {
    const status = ['open','reviewing','resolved','dismissed'].includes(body.status) ? body.status : 'reviewing';
    const report = await reportsRepository.updateStatus(reportId, status);
    if (!report) throw createHttpError(404, 'البلاغ غير موجود');
    await logModeration(actorUserId, 'report_status', 'report', reportId, null, { status });
    return { ok: true, status };
  }

  return { createReport, listReports, updateReportStatus };
}

module.exports = { createReportsService };
