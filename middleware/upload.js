const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists with absolute path
const uploadDir = path.join(__dirname, '..', 'uploads');

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Check if directory exists, create if needed
    fs.access(uploadDir, (err) => {
      if (err) {
        fs.mkdir(uploadDir, { recursive: true }, (err) => {
          if (err) {
            console.error('Error creating upload directory:', err);
            return cb(err);
          }
          cb(null, uploadDir);
        });
      } else {
        cb(null, uploadDir);
      }
    });
  },
  filename: (req, file, cb) => {
    cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
  }
});

// Create multer instance with configuration
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit (increased from 50MB)
    fieldSize: 100 * 1024 * 1024  // 100MB limit for form fields
  }
});

module.exports = {
  upload,
  uploadDir
};