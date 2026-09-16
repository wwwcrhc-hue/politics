'use strict';

function createReportsRepository({ pool }) {
  async function createReport(report) {
    await pool.query(
      'insert into reports (id, reporter_id, target_type, target_id, reason, status, created_at) values ($1, $2, $3, $4, $5, $6, $7)',
      [report.id, report.reporterId, report.targetType, report.targetId, report.reason, report.status, report.createdAt]
    );
  }

  async function listReports() {
    const { rows } = await pool.query('select rp.*,u.username,u.display_name from reports rp join users u on u.id=rp.reporter_id order by rp.created_at desc limit 300');
    return rows;
  }

  async function updateStatus(id, status) {
    const { rows } = await pool.query('update reports set status=$1 where id=$2 returning *', [status, id]);
    return rows[0] || null;
  }

  return { createReport, listReports, updateStatus };
}

module.exports = { createReportsRepository };
