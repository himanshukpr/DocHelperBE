const Tesseract = require('tesseract.js');
const { delfile } = require('../utils');

// Controller for text extraction
const extractText = (req, res) => {
  if (req.file) {
    console.log('File uploaded:', req.file.path);
    // Read the uploaded file and extract text using Tesseract.js
    Tesseract.recognize(
      req.file.path,
      'eng',
      {
        logger: m => console.log(m)
      }
    )
      .then(({ data: { text } }) => {
        console.log('Extracted text:', text);
        // Remove the file
        delfile(req.file.path)
        res.send({ message: 'File uploaded successfully', text: text });
      })
      .catch(err => {
        console.error('Error:', err);
        delfile(req.file.path)
        res.status(500).send({ message: 'Error processing image', error: err });
      });
  } else {
    res.status(400).send({ message: 'File upload failed' });
  }
};

module.exports = {
  extractText
};