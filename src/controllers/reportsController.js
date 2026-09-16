'use strict';

function createReportsController({ reportsService }) {
  function handleError(error, res, next) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }

  async function createReport(req, res, next) {
    try {
      res.status(201).json(await reportsService.createReport(req.user.id, req.body));
    } catch (e) { next(e); }
  }

  async function listReports(_req, res, next) {
    try {
      res.json(await reportsService.listReports());
    } catch (e) { next(e); }
  }

  async function updateReportStatus(req, res, next) {
    try {
      res.json(await reportsService.updateReportStatus(req.user.id, req.params.id, req.body));
    } catch (e) { handleError(e, res, next); }
  }

  return { createReport, listReports, updateReportStatus };
}

module.exports = { createReportsController };
