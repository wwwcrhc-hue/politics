'use strict';

function createErrorHandler({ multer, logError }) {
  return function errorHandler(error, req, res, next) {
    logError(error, `${req.method} ${req.originalUrl}`);
    console.error(error);
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف أكبر من 200MB' : 'خطأ في رفع الملف' });
    res.status(error.status || 500).json({ error: 'حدث خطأ داخلي غير متوقع', details: process.env.NODE_ENV === 'production' ? undefined : String(error.message || error) });
  };
}

module.exports = { createErrorHandler };
