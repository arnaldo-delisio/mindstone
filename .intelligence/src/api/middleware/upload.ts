import multer from 'multer';
import type { Request } from 'express';

/**
 * File upload middleware using multer
 * Accepts PDF, EPUB, DOCX files with no hard size limit
 * Files stored in memory (Buffer) for processing
 */

// Configure storage (memory storage - files held in RAM temporarily)
const storage = multer.memoryStorage();

// File filter - accept only PDF, EPUB, DOCX
const fileFilter = (
  req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
): void => {
  const allowedTypes = [
    'application/pdf',
    'application/epub+zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(
      `Unsupported file type: ${file.mimetype}. ` +
      `Accepted types: PDF (.pdf), EPUB (.epub), DOCX (.docx)`
    ));
  }
};

// Configure multer
const upload = multer({
  storage,
  fileFilter,
  // No size limit (per CONTEXT.md - accept any size, warn at 50MB in route)
});

/**
 * Upload middleware for single file uploads
 * Field name: 'file'
 */
export const uploadMiddleware = upload.single('file');
