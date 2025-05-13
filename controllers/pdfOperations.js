const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { uploadDir } = require('../middleware/upload');
const { execFile } = require('child_process');
const util = require('util');
const sharp = require('sharp');

const execFilePromise = util.promisify(execFile);

// Fix: Use separate names for PDF libraries to avoid conflict
const PDFKit = require('pdfkit');
const { PDFDocument } = require('pdf-lib');

// List merged PDFs function
const listMergedPDFs = async (req, res) => {
  try {
    const files = await fs.readdir(uploadDir);
    const pdfFiles = [];

    // Process files asynchronously
    for (const file of files) {
      if (file.endsWith('.pdf') && file.startsWith('merged-')) {
        try {
          const stats = await fs.stat(path.join(uploadDir, file));
          pdfFiles.push({
            name: file,
            url: `/uploads/${file}`,
            date: stats.mtime
          });
        } catch (err) {
          console.error(`Error processing file ${file}:`, err);
          // Skip problematic files but continue processing others
        }
      }
    }

    res.json(pdfFiles);
  } catch (error) {
    console.error('Error listing merged PDFs:', error);
    res.status(500).json({
      error: 'Failed to list merged PDFs',
      details: error.message
    });
  }
};

// PDF Merge function
const mergePDFs = async (req, res) => {
  try {
    // Validate input files
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({
        error: 'At least 2 PDFs required for merging',
        details: `Received ${req.files?.length || 0} files`
      });
    }

    // Fix: Create PDFDocument using pdf-lib
    const mergedPdf = await PDFDocument.create();
    const tempFiles = [];
    const fileDetails = [];

    try {
      // Collect and order files
      const orderedFiles = [];
      for (const file of req.files) {
        const orderIndex = parseInt(req.body[`order_${orderedFiles.length}`]);
        orderedFiles.push({
          file,
          order: isNaN(orderIndex) ? orderedFiles.length : orderIndex
        });
      }

      // Sort files by their order index
      orderedFiles.sort((a, b) => a.order - b.order);

      // Process each PDF with enhanced validation
      for (const { file } of orderedFiles) {
        try {
          // Validate file type
          if (!file.mimetype.includes('pdf')) {
            throw new Error(`Invalid file type: ${file.mimetype}`);
          }

          // Read and validate file content
          const pdfBytes = await fsp.readFile(file.path);
          tempFiles.push(file.path);

          // Validate PDF structure - Fix: Load with pdf-lib's PDFDocument
          const pdfDoc = await PDFDocument.load(pdfBytes);
          const pageCount = pdfDoc.getPageCount();

          if (pageCount === 0) {
            throw new Error('PDF contains no pages');
          }

          // Track file details for debugging
          fileDetails.push({
            name: file.originalname,
            size: file.size,
            pages: pageCount,
            path: file.path
          });

          // Copy pages to merged document
          const pages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
          pages.forEach(page => mergedPdf.addPage(page));
        } catch (err) {
          console.error(`Error processing ${file.originalname}:`, {
            error: err.message,
            stack: err.stack,
            file: {
              name: file.originalname,
              size: file.size,
              type: file.mimetype
            }
          });
          throw new Error(`Failed to process ${file.originalname}: ${err.message}`);
        }
      }

      // Generate merged PDF
      const mergedPdfBytes = await mergedPdf.save();
      const outputFilename = `merged-${Date.now()}.pdf`;
      const outputPath = path.join(uploadDir, outputFilename);
      const absolutePath = path.resolve(outputPath);

      // Ensure directory exists
      await fsp.mkdir(uploadDir, { recursive: true });

      // Write merged file
      await fsp.writeFile(outputPath, mergedPdfBytes);
      tempFiles.push(outputPath);

      console.log('Successfully merged PDFs:', {
        outputPath: absolutePath,
        size: mergedPdfBytes.length,
        sourceFiles: fileDetails
      });

      res.json({
        mergedPdfPath: absolutePath,
        url: `/uploads/${outputFilename}`,
        message: 'PDFs merged successfully',
        details: {
          totalPages: mergedPdf.getPageCount(),
          fileCount: req.files.length
        }
      });
    } catch (error) {
      // Clean up any created files
      await Promise.all(
        tempFiles.map(file =>
          fsp.unlink(file).catch(e =>
            console.error('Cleanup failed for:', file, e)
          )
        )
      );
      throw error;
    }
  } catch (error) {
    console.error('PDF merge failed:', {
      timestamp: new Date().toISOString(),
      error: {
        message: error.message,
        stack: error.stack
      },
      request: {
        files: req.files?.map(f => ({
          name: f.originalname,
          size: f.size,
          type: f.mimetype
        }))
      }
    });

    res.status(500).json({
      error: 'PDF merge operation failed',
      details: error.message,
      suggestion: 'Please ensure all files are valid PDFs and try again'
    });
  }
};

// PDF Split function
const splitPDF = async (req, res) => {
  try {
    console.log('Split PDF request received');
    if (!req.file) {
      console.log('No file uploaded');
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    console.log(`Processing file: ${req.file.originalname} (${req.file.size} bytes)`);

    // Validate PDF file
    if (!req.file.mimetype.includes('pdf')) {
      console.log('Invalid file type:', req.file.mimetype);
      await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error:', e));
      return res.status(400).json({ error: 'Only PDF files are allowed' });
    }

    // Verify file exists and is readable
    try {
      await fsp.access(req.file.path, fs.constants.R_OK);
    } catch (err) {
      console.error('File access error:', err);
      return res.status(400).json({ error: 'Uploaded file is not accessible' });
    }

    let pdfDoc;
    try {
      const pdfBytes = await fsp.readFile(req.file.path);
      // Fix: Load with pdf-lib's PDFDocument
      pdfDoc = await PDFDocument.load(pdfBytes);
    } catch (err) {
      console.error('PDF loading error:', err);
      await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error:', e));
      return res.status(400).json({ error: 'Invalid or corrupted PDF file' });
    }

    const pageCount = pdfDoc.getPageCount();
    console.log(`PDF has ${pageCount} pages`);

    if (pageCount <= 1) {
      console.log('PDF has only one page - nothing to split');
      await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error:', e));
      return res.status(400).json({ error: 'PDF must have more than one page to split' });
    }

    const splitResults = [];
    const tempFiles = [req.file.path]; // Track original file for cleanup

    // Split each page into separate PDFs
    for (let i = 0; i < pageCount; i++) {
      try {
        console.log(`Processing page ${i + 1}/${pageCount}`);
        // Fix: Create PDFDocument using pdf-lib
        const newPdf = await PDFDocument.create();
        const [page] = await newPdf.copyPages(pdfDoc, [i]);
        newPdf.addPage(page);

        const splitPdfBytes = await newPdf.save({ useObjectStreams: false });
        const outputFilename = `split-page-${i + 1}-${Date.now()}.pdf`;
        const outputPath = path.join(uploadDir, outputFilename);

        // Ensure directory exists and write file with proper permissions
        await fsp.mkdir(uploadDir, { recursive: true });
        await fsp.writeFile(outputPath, Buffer.from(splitPdfBytes), { mode: 0o644 });
        tempFiles.push(outputPath);

        const fullPath = path.resolve(outputPath).replace(/\\/g, '/');
        console.log(`Created split page: ${fullPath}`);

        splitResults.push({
          fullPath: fullPath,
          pageNumber: i + 1,
          filename: outputFilename,
          url: `/uploads/${outputFilename}`,
          size: splitPdfBytes.length
        });
      } catch (err) {
        console.error(`Error splitting page ${i + 1}:`, err);
        // Continue with next page even if one fails
      }
    }

    if (splitResults.length === 0) {
      console.error('Failed to split any pages');
      await Promise.all(tempFiles.map(file =>
        fsp.unlink(file).catch(e => console.error('Cleanup error:', e)))
      );
      return res.status(500).json({
        error: 'Failed to split any pages',
        details: 'All page splitting attempts failed'
      });
    }

    // Clean up files after 1 hour
    setTimeout(async () => {
      console.log('Cleaning up temporary files');
      await Promise.all(tempFiles.map(file =>
        fsp.unlink(file).catch(e => console.error('Cleanup error:', e)))
      );
    }, 3600000);

    console.log(`Successfully split into ${splitResults.length} pages`);
    res.json({
      success: true,
      message: `PDF split into ${splitResults.length} pages`,
      pages: splitResults,
      originalFile: req.file.originalname
    });

  } catch (error) {
    console.error('PDF split error:', {
      message: error.message,
      stack: error.stack,
      file: req.file ? req.file.path : 'No file'
    });
    res.status(500).json({
      error: 'Failed to split PDF',
      details: error.message
    });
  }
};

// Download PDF function
const downloadFile = async (req, res) => {
  try {
    const filePath = decodeURIComponent(req.query.file);
    if (!filePath) {
      return res.status(400).send('File query parameter is missing');
    }

    console.log('Download request for file:', filePath);

    // Handle both relative and absolute paths
    let absolutePath;

    if (path.isAbsolute(filePath)) {
      // Path is absolute, check if it's inside the uploads directory
      absolutePath = path.normalize(filePath);
      const uploadsDir = path.resolve(uploadDir);

      if (!absolutePath.startsWith(uploadsDir)) {
        // If the absolute path is outside uploads dir, try to extract the filename
        const filename = path.basename(filePath);
        absolutePath = path.join(uploadDir, filename);
        console.log('Adjusted path to uploads directory:', absolutePath);
      }
    } else {
      // Path is relative, resolve from uploads directory
      absolutePath = path.join(uploadDir, filePath);
    }

    console.log('Final resolved path:', absolutePath);

    try {
      await fsp.access(absolutePath, fs.constants.R_OK); // Check if file exists and is readable
    } catch (err) {
      console.error('File not accessible:', err);

      // If file not found, try looking for it in the uploads directory by basename
      try {
        const basename = path.basename(filePath);
        const files = await fsp.readdir(uploadDir);
        for (const file of files) {
          if (file === basename) {
            absolutePath = path.join(uploadDir, file);
            console.log('Found file by basename in uploads directory:', absolutePath);
            break;
          }
        }

        // Check if the found file is accessible
        await fsp.access(absolutePath, fs.constants.R_OK);
      } catch (fallbackErr) {
        console.error('File not found in fallback check:', fallbackErr);
        return res.status(404).send('File not found');
      }
    }

    console.log('Sending file:', absolutePath);
    res.download(absolutePath, path.basename(absolutePath), (err) => {
      if (err) {
        console.error('Download failed:', err);
        if (!res.headersSent) {
          res.status(500).send('Error downloading file');
        }
      }
    });
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).send('Error downloading file');
  }
};

// PDF Compression function
const compressPDF = async (req, res) => {
  try {
    console.log('Compress PDF request received');
    if (!req.file) {
      console.log('No file uploaded');
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    console.log(`Processing file for compression: ${req.file.originalname} (${req.file.size} bytes)`);

    // Validate PDF file
    if (!req.file.mimetype.includes('pdf')) {
      console.log('Invalid file type:', req.file.mimetype);
      await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error:', e));
      return res.status(400).json({ error: 'Only PDF files are allowed' });
    }

    // Get the compression level from request (default to medium if not specified)
    const compressionLevel = req.body.compressionLevel || 'medium';
    console.log(`Compression level requested: ${compressionLevel}`);

    try {
      // Get file stats for original size
      const fileStats = await fsp.stat(req.file.path);
      const originalSizeKB = Math.round(fileStats.size / 1024);

      // Define output path
      const outputFilename = `compressed-${Date.now()}.pdf`;
      const outputPath = path.join(uploadDir, outputFilename);

      // Modified approach for handling complex PDFs
      // Read the original PDF file
      const pdfBytes = await fsp.readFile(req.file.path);

      // Try to use more direct binary-level approach for compression
      // which is less sensitive to PDF structure issues
      try {
        console.log("Using direct binary compression approach");

        // Create a simple duplicate of the PDF first
        await fsp.copyFile(req.file.path, outputPath);

        // Now try to load it with less validation
        const options = {
          ignoreEncryption: true,
          updateMetadata: false,
          parseSpeed: 1 // Fast parsing with less validation
        };

        try {
          // Try to load the PDF with minimal validation - Fix: Use pdf-lib's PDFDocument
          const pdfDoc = await PDFDocument.load(pdfBytes, options);

          // Remove metadata which often helps with size
          pdfDoc.setTitle('');
          pdfDoc.setAuthor('');
          pdfDoc.setSubject('');
          pdfDoc.setKeywords([]);
          pdfDoc.setProducer('DocHelper');
          pdfDoc.setCreator('DocHelper');

          // Prepare compression settings based on level
          let compressionOptions = {
            useObjectStreams: true,
            addCompression: true
          };

          // Adjust compression level
          if (compressionLevel === 'high') {
            compressionOptions.objectsPerStream = 100; // Use lower value to avoid errors
          } else if (compressionLevel === 'medium') {
            compressionOptions.objectsPerStream = 50;
          } else {
            compressionOptions.objectsPerStream = 20;
          }

          // Save with compression
          const compressedBytes = await pdfDoc.save(compressionOptions);

          // Only replace if the compressed version is actually smaller
          if (compressedBytes.length < pdfBytes.length) {
            await fsp.writeFile(outputPath, Buffer.from(compressedBytes));
            console.log("Compression successful, using the compressed version");
          } else {
            console.log("Compressed version is larger, reverting to original");
          }

        } catch (pdfError) {
          console.log("Error processing PDF with pdf-lib:", pdfError.message);
          // Keep the duplicate as a fallback (already created above)
        }

        // Alternative compression approach using basic buffer compression
        if (compressionLevel === 'high') {
          try {
            console.log("Trying alternative compression method");

            // Read the current output file
            const currentBytes = await fsp.readFile(outputPath);

            // Use Node's built-in zlib for a basic level of compression
            const zlib = require('zlib');

            // Create a temporary compressed file using deflate
            const tempCompressedPath = path.join(uploadDir, `temp-${Date.now()}.bin`);

            // Compress with appropriate level
            let level = 6; // Default (medium)
            if (compressionLevel === 'high') level = 9;
            if (compressionLevel === 'low') level = 3;

            // Create deflated stream
            const output = fs.createWriteStream(tempCompressedPath);
            const compress = zlib.createDeflate({ level });

            // Create read stream and pipe through compression
            const input = fs.createReadStream(outputPath);

            await new Promise((resolve, reject) => {
              input.pipe(compress).pipe(output)
                .on('finish', resolve)
                .on('error', reject);
            });

            // Check the compressed size
            const compressedStats = await fsp.stat(tempCompressedPath);

            // If it's smaller, use it for certain types of PDFs
            if (compressedStats.size < currentBytes.length * 0.9) {
              console.log("Binary compression successful, using compressed version");

              // Read the compressed data
              const compressedData = await fsp.readFile(tempCompressedPath);

              // Read the original PDF header to preserve it
              const header = currentBytes.slice(0, 1024); // Preserve PDF header

              // Create a new buffer with header and compressed content
              const combinedBuffer = Buffer.concat([
                header,
                compressedData
              ]);

              // Write back to the output file
              await fsp.writeFile(outputPath, combinedBuffer);
            }

            // Clean up temporary file
            await fsp.unlink(tempCompressedPath).catch(() => { });

          } catch (zlibError) {
            console.log("Alternative compression failed:", zlibError.message);
          }
        }

        // Get final compressed file stats
        const compressedStats = await fsp.stat(outputPath);
        const compressedSizeKB = Math.round(compressedStats.size / 1024);
        const compressionRatio = Math.round((1 - (compressedStats.size / fileStats.size)) * 100);

        // Clean up original uploaded file
        await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error:', e));

        console.log(`Compression results: Original: ${originalSizeKB}KB, Compressed: ${compressedSizeKB}KB, Ratio: ${compressionRatio}%`);

        return res.json({
          success: true,
          message: compressionRatio > 0
            ? `PDF compressed successfully - reduced by ${compressionRatio}%`
            : "PDF processed successfully (no size reduction achieved)",
          originalFile: req.file.originalname,
          originalSize: originalSizeKB,
          compressedSize: compressedSizeKB,
          compressionRatio: Math.max(0, compressionRatio),
          url: `/uploads/${outputFilename}`,
          fullPath: path.resolve(outputPath)
        });

      } catch (err) {
        console.log("Binary compression approach failed:", err);

        // Fallback to simple copy if everything else fails
        await fsp.copyFile(req.file.path, outputPath);

        // Clean up original uploaded file
        await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error:', e));

        res.json({
          success: true,
          message: "PDF could not be compressed but is available for download",
          originalFile: req.file.originalname,
          originalSize: originalSizeKB,
          compressedSize: originalSizeKB,
          compressionRatio: 0,
          url: `/uploads/${outputFilename}`,
          fullPath: path.resolve(outputPath)
        });
      }

    } catch (err) {
      console.error('PDF compression error:', err);

      // If compression fails completely, try fallback to simple copy
      try {
        console.log('All compression methods failed, using fallback copy method');
        const outputFilename = `compressed-${Date.now()}.pdf`;
        const outputPath = path.join(uploadDir, outputFilename);

        // Simply copy the file as fallback
        await fsp.copyFile(req.file.path, outputPath);

        const fileStats = await fsp.stat(req.file.path);
        const originalSizeKB = Math.round(fileStats.size / 1024);

        // Clean up original uploaded file
        await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error:', e));

        res.json({
          success: true,
          message: "PDF could not be compressed but is available for download",
          originalFile: req.file.originalname,
          originalSize: originalSizeKB,
          compressedSize: originalSizeKB,
          compressionRatio: 0,
          url: `/uploads/${outputFilename}`,
          fullPath: path.resolve(outputPath)
        });
      } catch (fallbackErr) {
        console.error('Fallback method failed:', fallbackErr);
        await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error:', e));
        return res.status(500).json({
          error: 'Failed to process PDF',
          details: err.message
        });
      }
    }

  } catch (error) {
    console.error('PDF compression handler error:', {
      message: error.message,
      stack: error.stack,
      file: req.file ? req.file.path : 'No file'
    });
    res.status(500).json({
      error: 'Failed to compress PDF',
      details: error.message
    });
  }
};

// Image to PDF function
const imageToPDF = async (req, res) => {
  try {
    console.log('Image to PDF request received');
    if (!req.files || req.files.length === 0) {
      console.log('No images uploaded');
      return res.status(400).json({ error: 'No image files uploaded' });
    }

    console.log(`Processing ${req.files.length} images for conversion to PDF`);

    // Validate all files are images
    for (const file of req.files) {
      if (!file.mimetype.startsWith('image/')) {
        console.log('Invalid file type:', file.mimetype);
        // Clean up uploaded files
        await Promise.all(req.files.map(f =>
          fsp.unlink(f.path).catch(e => console.error('Cleanup error:', e))
        ));
        return res.status(400).json({ error: `Invalid file type: ${file.mimetype}. Only image files are allowed.` });
      }
    }

    // Get PDF settings from request
    const pageSize = req.body.pageSize || 'a4';
    const orientation = req.body.orientation || 'portrait';
    console.log(`PDF settings: Size=${pageSize}, Orientation=${orientation}`);

    // Collect and order files
    const orderedFiles = [];
    for (const file of req.files) {
      const orderIndex = parseInt(req.body[`order_${orderedFiles.length}`]);
      orderedFiles.push({
        file,
        order: isNaN(orderIndex) ? orderedFiles.length : orderIndex
      });
    }

    // Sort files by their order index
    orderedFiles.sort((a, b) => a.order - b.order);

    // Define page dimensions in points (72 points per inch)
    let pageWidth, pageHeight;

    switch (pageSize.toLowerCase()) {
      case 'a4':
        pageWidth = 595;  // 8.27 x 11.69 inches
        pageHeight = 842;
        break;
      case 'letter':
        pageWidth = 612;  // 8.5 x 11 inches
        pageHeight = 792;
        break;
      case 'legal':
        pageWidth = 612;  // 8.5 x 14 inches
        pageHeight = 1008;
        break;
      case 'a3':
        pageWidth = 842;  // 11.69 x 16.54 inches
        pageHeight = 1191;
        break;
      case 'a5':
        pageWidth = 420;  // 5.83 x 8.27 inches
        pageHeight = 595;
        break;
      default:
        pageWidth = 595;
        pageHeight = 842;
    }

    // Swap dimensions if landscape orientation
    if (orientation.toLowerCase() === 'landscape') {
      [pageWidth, pageHeight] = [pageHeight, pageWidth];
    }

    // Create the output PDF file
    const outputFilename = `image-pdf-${Date.now()}.pdf`;
    const outputPath = path.join(uploadDir, outputFilename);
    const absolutePath = path.resolve(outputPath);

    // Create a new PDF document using PDFKit
    const pdfDoc = new PDFKit({
      size: [pageWidth, pageHeight],
      autoFirstPage: false,
      margin: 0
    });

    // Pipe the PDF document to a write stream
    const writeStream = fs.createWriteStream(outputPath);
    pdfDoc.pipe(writeStream);

    const tempFiles = [];
    const imageDetails = [];

    try {
      // Process each image
      for (const { file } of orderedFiles) {
        try {
          console.log(`Processing image: ${file.originalname}`);

          // Get image dimensions and format using Sharp
          const imageInfo = await sharp(file.path).metadata();

          // Track file for cleanup
          tempFiles.push(file.path);

          // Add a new page for each image
          pdfDoc.addPage({ size: [pageWidth, pageHeight], margin: 0 });

          // Calculate dimensions to fit image proportionally within page
          const imgWidth = imageInfo.width;
          const imgHeight = imageInfo.height;

          // Add margins (0.5 inch on each side)
          const margin = 36; // 0.5 inch in points
          const maxWidth = pageWidth - (margin * 2);
          const maxHeight = pageHeight - (margin * 2);

          // Calculate scaled dimensions while preserving aspect ratio
          let scaledWidth = imgWidth;
          let scaledHeight = imgHeight;

          // Scale down if image is larger than page
          const widthRatio = maxWidth / imgWidth;
          const heightRatio = maxHeight / imgHeight;
          const scale = Math.min(widthRatio, heightRatio, 1);

          scaledWidth = imgWidth * scale;
          scaledHeight = imgHeight * scale;

          // Center the image on page
          const x = (pageWidth - scaledWidth) / 2;
          const y = (pageHeight - scaledHeight) / 2;

          // Use PDFKit's image() method to add the image
          pdfDoc.image(file.path, x, y, {
            width: scaledWidth,
            height: scaledHeight
          });

          // Track image details for response
          imageDetails.push({
            name: file.originalname,
            originalSize: file.size,
            dimensions: `${imageInfo.width}x${imageInfo.height}`,
            format: imageInfo.format,
            pageSize: `${pageWidth}x${pageHeight}`
          });

        } catch (err) {
          console.error(`Error processing image ${file.originalname}:`, err);
          // Continue processing other images
        }
      }

      // Finalize the PDF
      pdfDoc.end();

      // Wait for the write stream to finish
      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      console.log('Successfully created PDF from images:', {
        outputPath: absolutePath,
        sourceFiles: imageDetails.length,
        pageSize,
        orientation
      });

      // Clean up temporary image files, but keep the generated PDF
      await Promise.all(
        tempFiles.map(file =>
          fsp.unlink(file).catch(e =>
            console.error('Cleanup failed for:', file, e)
          )
        )
      );

      res.json({
        fullPath: absolutePath,
        url: `/uploads/${outputFilename}`,
        message: `Successfully created PDF with ${imageDetails.length} images`,
        details: {
          totalPages: imageDetails.length,
          fileCount: req.files.length,
          pageSize,
          orientation
        }
      });

    } catch (error) {
      // Clean up any created files on error
      await Promise.all(
        tempFiles.map(file =>
          fsp.unlink(file).catch(e =>
            console.error('Cleanup failed for:', file, e)
          )
        )
      );
      
      // Try to clean up the partially created PDF
      try {
        await fsp.unlink(outputPath).catch(() => {});
      } catch (cleanupError) {
        console.error('Failed to clean up partial PDF:', cleanupError);
      }
      
      throw error;
    }

  } catch (error) {
    console.error('Image to PDF conversion failed:', {
      message: error.message,
      stack: error.stack,
      files: req.files?.map(f => ({
        name: f.originalname,
        size: f.size,
        type: f.mimetype
      }))
    });

    res.status(500).json({
      error: 'Image to PDF conversion failed',
      details: error.message,
      suggestion: 'Please ensure all files are valid images and try again'
    });
  }
};

// PDF to Image function
const pdfToImage = async (req, res) => {
  try {
    console.log('PDF to Image request received');
    if (!req.file) {
      console.log('No file uploaded');
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    console.log(`Processing file: ${req.file.originalname} (${req.file.size} bytes)`);

    // Validate PDF file
    if (!req.file.mimetype.includes('pdf')) {
      console.log('Invalid file type:', req.file.mimetype);
      await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error:', e));
      return res.status(400).json({ error: 'Only PDF files are allowed' });
    }

    // Get conversion settings
    const imageFormat = (req.body.imageFormat || 'png').toLowerCase();
    const imageQuality = req.body.imageQuality || 'medium';

    console.log(`Conversion settings: Format=${imageFormat}, Quality=${imageQuality}`);

    // Map quality setting to numerical value
    let quality = 80; // Default medium quality
    if (imageQuality === 'low') quality = 60;
    if (imageQuality === 'high') quality = 100;

    // Verify file exists and is readable
    try {
      await fsp.access(req.file.path, fs.constants.R_OK);
    } catch (err) {
      console.error('File access error:', err);
      return res.status(400).json({ error: 'Uploaded file is not accessible' });
    }

    // Attempt to load the PDF document
    let pdfDoc;
    try {
      const pdfBytes = await fsp.readFile(req.file.path);
      // Fix: Load with pdf-lib's PDFDocument
      pdfDoc = await PDFDocument.load(pdfBytes);
    } catch (err) {
      console.error('PDF loading error:', err);
      await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error:', e));
      return res.status(400).json({ error: 'Invalid or corrupted PDF file' });
    }

    const pageCount = pdfDoc.getPageCount();
    console.log(`PDF has ${pageCount} pages`);

    if (pageCount === 0) {
      console.log('PDF has no pages');
      await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error:', e));
      return res.status(400).json({ error: 'PDF has no pages to convert' });
    }

    // Create timestamp for this batch
    const timestamp = Date.now();
    const batchDir = path.join(uploadDir, `pdf-images-${timestamp}`);

    // Create directory for the images
    await fsp.mkdir(batchDir, { recursive: true });

    const imageResults = [];
    const tempFiles = [req.file.path]; // Track original file for cleanup

    try {
      // Import packages needed for PDF rendering
      const { createCanvas } = require('canvas');
      const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

      // Initialize PDF.js
      const pdfjsVersion = await pdfjs.version;
      console.log(`Using PDF.js version: ${pdfjsVersion}`);

      // Set the PDF.js workerSrc
      const pdfjsWorker = require('pdfjs-dist/legacy/build/pdf.worker.js');

      // Load the PDF document using PDF.js
      const data = new Uint8Array(await fsp.readFile(req.file.path));
      const loadingTask = pdfjs.getDocument({ data });
      const pdf = await loadingTask.promise;

      console.log(`PDF loaded with ${pdf.numPages} pages`);

      // Process each page
      for (let i = 1; i <= pdf.numPages; i++) {
        try {
          console.log(`Processing page ${i}/${pdf.numPages}`);

          // Get page
          const page = await pdf.getPage(i);

          // Calculate dimensions
          const viewport = page.getViewport({ scale: quality / 72 }); // DPI to scale conversion

          // Create canvas to render to
          const canvas = createCanvas(viewport.width, viewport.height);
          const context = canvas.getContext('2d');

          // Render PDF page to canvas
          await page.render({
            canvasContext: context,
            viewport: viewport
          }).promise;

          // Convert canvas to image
          let imageBuffer;
          if (imageFormat === 'png') {
            imageBuffer = canvas.toBuffer('image/png');
          } else if (imageFormat === 'webp') {
            imageBuffer = canvas.toBuffer('image/webp', { quality: quality / 100 });
          } else {
            // Default to JPEG
            imageBuffer = canvas.toBuffer('image/jpeg', { quality: quality / 100 });
          }

          // Save the image
          const outputFilename = `page-${i}-${timestamp}.${imageFormat}`;
          const outputPath = path.join(batchDir, outputFilename);
          await fsp.writeFile(outputPath, imageBuffer);
          tempFiles.push(outputPath);

          // Get file stats
          const stats = await fsp.stat(outputPath);

          // Add to results
          const fullPath = path.resolve(outputPath).replace(/\\/g, '/');
          imageResults.push({
            fullPath: fullPath,
            pageNumber: i,
            filename: outputFilename,
            url: `/uploads/pdf-images-${timestamp}/${outputFilename}`,
            size: stats.size,
            width: viewport.width,
            height: viewport.height
          });

        } catch (pageErr) {
          console.error(`Error processing page ${i}:`, pageErr);
          // Continue with next page
        }
      }

      if (imageResults.length === 0) {
        throw new Error('Failed to convert any pages to images');
      }

      // Create a ZIP file with all images for bulk download
      const archiver = require('archiver');
      const zipFilename = `pdf-images-${timestamp}.zip`;
      const zipPath = path.join(uploadDir, zipFilename);
      const zipOutput = fs.createWriteStream(zipPath);
      const archive = archiver('zip', {
        zlib: { level: 9 } // Maximum compression
      });

      // Listen for all archive data to be written
      await new Promise((resolve, reject) => {
        zipOutput.on('close', resolve);
        archive.on('error', reject);

        // Pipe archive data to the output file
        archive.pipe(zipOutput);

        // Add each image to the archive
        imageResults.forEach(image => {
          archive.file(image.fullPath, { name: image.filename });
        });

        // Finalize the archive
        archive.finalize();
      });

      console.log(`Created ZIP archive at ${zipPath}`);

      // Clean up original PDF file after an hour
      setTimeout(async () => {
        console.log('Cleaning up temporary PDF file');
        await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error:', e));
      }, 3600000); // 1 hour

      // Clean up image folder after a day
      setTimeout(async () => {
        console.log('Cleaning up image directory');
        await fs.rm(batchDir, { recursive: true, force: true }, (err) => {
          if (err) console.error('Error deleting directory:', err);
        });

        await fsp.unlink(zipPath).catch(e => console.error('Cleanup error:', e));
      }, 86400000); // 24 hours

      res.json({
        success: true,
        message: `PDF converted to ${imageResults.length} images`,
        images: imageResults,
        zipUrl: `/uploads/${zipFilename}`,
        format: imageFormat,
        quality: imageQuality,
        originalFile: req.file.originalname
      });

    } catch (error) {
      console.error('PDF to Image conversion error:', error);

      // Try even simpler fallback method
      try {
        console.log('Attempting fallback conversion method using PDF extraction');

        let pdfParsed = false;

        // Try using pdf-parse as a last resort to extract at least some content
        try {
          const pdfParse = require('pdf-parse');
          const dataBuffer = await fsp.readFile(req.file.path);

          for (let i = 0; i < pageCount; i++) {
            try {
              // Extract single page as PDF
              // Fix: Create PDFDocument using pdf-lib
              const singlePagePdf = await PDFDocument.create();
              const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
              singlePagePdf.addPage(copiedPage);
              const pdfBytes = await singlePagePdf.save();

              // Parse the page content
              const pdfData = await pdfParse(Buffer.from(pdfBytes));

              // Create a simple image with text content
              const { createCanvas } = require('canvas');
              const canvas = createCanvas(800, 1200);  // Default size
              const ctx = canvas.getContext('2d');

              // Fill with white background
              ctx.fillStyle = 'white';
              ctx.fillRect(0, 0, canvas.width, canvas.height);

              // Add text content
              ctx.font = '16px Arial';
              ctx.fillStyle = 'black';

              const lines = pdfData.text.split('\n');
              let y = 50;

              // Add page info
              ctx.font = '24px Arial';
              ctx.fillText(`Page ${i + 1} of ${pageCount}`, 50, y);
              y += 50;

              // Add content
              ctx.font = '16px Arial';
              lines.forEach(line => {
                if (line.trim()) {
                  ctx.fillText(line, 50, y);
                  y += 24;
                } else {
                  y += 12;
                }

                // If we run out of vertical space, stop
                if (y > canvas.height - 50) return;
              });

              // Save the image
              const outputFilename = `page-${i + 1}-${timestamp}.${imageFormat}`;
              const outputPath = path.join(batchDir, outputFilename);

              let imageBuffer;
              if (imageFormat === 'png') {
                imageBuffer = canvas.toBuffer('image/png');
              } else if (imageFormat === 'webp') {
                imageBuffer = canvas.toBuffer('image/webp', { quality: quality / 100 });
              } else {
                imageBuffer = canvas.toBuffer('image/jpeg', { quality: quality / 100 });
              }

              await fsp.writeFile(outputPath, imageBuffer);

              // Get file stats
              const stats = await fsp.stat(outputPath);

              // Add to results
              const fullPath = path.resolve(outputPath).replace(/\\/g, '/');
              imageResults.push({
                fullPath: fullPath,
                pageNumber: i + 1,
                filename: outputFilename,
                url: `/uploads/pdf-images-${timestamp}/${outputFilename}`,
                size: stats.size,
                width: canvas.width,
                height: canvas.height
              });

              pdfParsed = true;
            } catch (pageErr) {
              console.error(`Error processing page ${i + 1} in fallback:`, pageErr);
            }
          }
        } catch (parseErr) {
          console.error('PDF parse fallback failed:', parseErr);
        }

        if (!pdfParsed) {
          throw new Error('All conversion methods failed');
        }

        // Create ZIP file with all images
        const archiver = require('archiver');
        const zipFilename = `pdf-images-${timestamp}.zip`;
        const zipPath = path.join(uploadDir, zipFilename);
        const zipOutput = fs.createWriteStream(zipPath);
        const archive = archiver('zip', {
          zlib: { level: 9 } // Maximum compression
        });

        await new Promise((resolve, reject) => {
          zipOutput.on('close', resolve);
          archive.on('error', reject);

          archive.pipe(zipOutput);

          imageResults.forEach(image => {
            archive.file(image.fullPath, { name: image.filename });
          });

          archive.finalize();
        });

        console.log(`Created ZIP archive with fallback method at ${zipPath}`);

        res.json({
          success: true,
          message: `PDF converted to ${imageResults.length} images (simple extraction method used)`,
          images: imageResults,
          zipUrl: `/uploads/${zipFilename}`,
          format: imageFormat,
          quality: imageQuality,
          originalFile: req.file.originalname,
          note: "Basic conversion was used. Images may show text only without formatting."
        });

      } catch (fallbackError) {
        console.error('All PDF to Image conversion methods failed:', fallbackError);

        // Clean up any created files
        await Promise.all(
          tempFiles.map(file =>
            fsp.unlink(file).catch(e => console.error('Cleanup failed for:', file, e))
          )
        );

        try {
          await fs.rm(batchDir, { recursive: true, force: true }, (err) => {
            if (err) console.error('Error deleting directory:', err);
          });
        } catch (rmErr) {
          console.error('Error deleting directory:', rmErr);
        }

        throw new Error(`PDF to Image conversion failed: ${error.message}`);
      }
    }

  } catch (error) {
    console.error('PDF to Image handler error:', {
      message: error.message,
      stack: error.stack,
      file: req.file ? req.file.path : 'No file'
    });

    res.status(500).json({
      error: 'Failed to convert PDF to images',
      details: error.message,
      suggestion: 'Please try a different PDF file or use a different conversion method'
    });
  }
};

// PDF Protection function using qpdf
const protectPDF = async (req, res) => {
  try {
    console.log('Protect PDF request received');
    if (!req.file) {
      console.log('No file uploaded');
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const inputFile = req.file.path;
    console.log(`Processing file for protection: ${req.file.originalname} (${req.file.size} bytes) at ${inputFile}`);

    // Validate PDF file
    if (!req.file.mimetype.includes('pdf')) {
      console.log('Invalid file type:', req.file.mimetype);
      await fsp.unlink(inputFile).catch(e => console.error('Cleanup error (invalid type):', e));
      return res.status(400).json({ error: 'Only PDF files are allowed' });
    }

    // Get password from request
    const password = req.body.password;
    if (!password) {
      console.log('No password provided');
      await fsp.unlink(inputFile).catch(e => console.error('Cleanup error (no password):', e));
      return res.status(400).json({ error: 'Password is required' });
    }

    // Create output filename and path
    const outputFilename = `protected-${Date.now()}.pdf`;
    const outputPath = path.join(uploadDir, outputFilename);

    // Ensure directory exists
    await fsp.mkdir(uploadDir, { recursive: true });

    // --- qpdf execution ---
    const qpdfPath = 'qpdf'; // Assumes qpdf is in the system PATH
    const userPassword = password;
    const ownerPassword = password; // qpdf uses the same password for owner unless specified differently, but we need to provide it twice
    const keyLength = '128'; // Or '256'

    // Define permissions for qpdf (modify, print, copy, annotate)
    // 'y' = allow, 'n' = disallow
    const permissions = {
        modify: 'n',
        print: 'full', // 'full', 'low', 'none'
        copy: 'n',
        annotate: 'n'
    };

    const qpdfArgs = [
        '--encrypt',
        userPassword,
        ownerPassword, // Owner password
        keyLength,
        `--print=${permissions.print}`,
        `--modify=${permissions.modify === 'y' ? 'all' : 'none'}`, // qpdf uses 'all' or 'none'
        `--extract=${permissions.copy === 'y' ? 'y' : 'n'}`, // qpdf uses --extract for copy permission
        `--use-aes=y`, // Explicitly use AES
        '--', // End of options marker
        inputFile,
        outputPath
    ];

    console.log(`Executing qpdf: ${qpdfPath} ${qpdfArgs.join(' ')}`);

    try {
      const { stdout, stderr } = await execFilePromise(qpdfPath, qpdfArgs);

      if (stderr) {
        console.warn('qpdf stderr:', stderr); // Log warnings but proceed if exit code is 0
      }
      console.log('qpdf stdout:', stdout);
      console.log(`Successfully protected PDF with qpdf: ${outputPath}`);

      // Clean up the original uploaded file
      await fsp.unlink(inputFile).catch(e => console.error('Cleanup error (success):', e));

      // Return success response
      return res.json({
        success: true,
        message: 'PDF protected successfully with password using qpdf',
        originalFile: req.file.originalname,
        fullPath: path.resolve(outputPath),
        url: `/uploads/${outputFilename}`
      });

    } catch (qpdfError) {
      console.error('Error executing qpdf:', {
          message: qpdfError.message,
          stderr: qpdfError.stderr,
          stdout: qpdfError.stdout,
          code: qpdfError.code
      });
      // Clean up the original file if protection fails
      await fsp.unlink(inputFile).catch(e => console.error('Cleanup error (qpdf fail):', e));
      // Also remove potentially partially created output file
      await fsp.unlink(outputPath).catch(() => {}); // Ignore error if file doesn't exist

      return res.status(500).json({
        error: 'Failed to protect PDF using qpdf',
        details: qpdfError.stderr || qpdfError.message
      });
    }
    // --- End of qpdf execution ---

  } catch (error) {
    console.error('PDF protection handler error:', {
      message: error.message,
      stack: error.stack,
      file: req.file ? req.file.path : 'No file'
    });

    // Clean up uploaded file if it exists and an error occurred before processing
    if (req.file && req.file.path) {
      // Check if file still exists before attempting unlink
      try {
          await fsp.access(req.file.path);
          await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error (handler fail):', e));
      } catch (accessError) {
          // File likely already cleaned up or never existed, ignore
      }
    }

    res.status(500).json({
      error: 'Failed to protect PDF',
      details: error.message
    });
  }
};

// PDF Unprotection function
const unprotectPDF = async (req, res) => {
  try {
    console.log('Unprotect PDF request received');
    if (!req.file) {
      console.log('No file uploaded');
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const inputFile = req.file.path;
    console.log(`Processing file for unprotection: ${req.file.originalname} (${req.file.size} bytes) at ${inputFile}`);

    // Validate PDF file
    if (!req.file.mimetype.includes('pdf')) {
      console.log('Invalid file type:', req.file.mimetype);
      await fsp.unlink(inputFile).catch(e => console.error('Cleanup error (invalid type):', e));
      return res.status(400).json({ error: 'Only PDF files are allowed' });
    }

    // Get password from request
    const password = req.body.password;
    if (!password) {
      console.log('No password provided');
      await fsp.unlink(inputFile).catch(e => console.error('Cleanup error (no password):', e));
      return res.status(400).json({ error: 'Password is required' });
    }

    // Create output filename and path
    const outputFilename = `unprotected-${Date.now()}.pdf`;
    const outputPath = path.join(uploadDir, outputFilename);

    // Ensure directory exists
    await fsp.mkdir(uploadDir, { recursive: true });

    // --- qpdf execution ---
    const qpdfPath = 'qpdf'; // Assumes qpdf is in the system PATH

    // For decryption, we only need to supply the password as an argument
    const qpdfArgs = [
      '--password=' + password, // Supply the password
      '--decrypt',              // Specify we want to decrypt
      inputFile,                // Input file path
      outputPath                // Output file path
    ];

    console.log(`Executing qpdf for decryption: ${qpdfPath} ${qpdfArgs.join(' ')}`);

    try {
      const { stdout, stderr } = await execFilePromise(qpdfPath, qpdfArgs);

      if (stderr) {
        console.warn('qpdf stderr:', stderr); // Log warnings but proceed if exit code is 0
      }
      console.log('qpdf stdout:', stdout);
      console.log(`Successfully unprotected PDF with qpdf: ${outputPath}`);

      // Clean up the original uploaded file
      await fsp.unlink(inputFile).catch(e => console.error('Cleanup error (success):', e));

      // Return success response
      return res.json({
        success: true,
        message: 'PDF unprotected successfully',
        originalFile: req.file.originalname,
        fullPath: path.resolve(outputPath),
        url: `/uploads/${outputFilename}`
      });

    } catch (qpdfError) {
      console.error('Error executing qpdf for decryption:', {
        message: qpdfError.message,
        stderr: qpdfError.stderr,
        stdout: qpdfError.stdout,
        code: qpdfError.code
      });
      
      // Clean up the original file if unprotection fails
      await fsp.unlink(inputFile).catch(e => console.error('Cleanup error (qpdf fail):', e));
      // Also remove potentially partially created output file
      await fsp.unlink(outputPath).catch(() => {}); // Ignore error if file doesn't exist

      // Check if it's likely a password error
      if (qpdfError.stderr && qpdfError.stderr.includes('password')) {
        return res.status(401).json({
          error: 'Incorrect password for the PDF',
          details: 'Please check the password and try again'
        });
      }

      return res.status(500).json({
        error: 'Failed to unprotect PDF',
        details: qpdfError.stderr || qpdfError.message
      });
    }
    // --- End of qpdf execution ---

  } catch (error) {
    console.error('PDF unprotection handler error:', {
      message: error.message,
      stack: error.stack,
      file: req.file ? req.file.path : 'No file'
    });

    // Clean up uploaded file if it exists and an error occurred before processing
    if (req.file && req.file.path) {
      // Check if file still exists before attempting unlink
      try {
        await fsp.access(req.file.path);
        await fsp.unlink(req.file.path).catch(e => console.error('Cleanup error (handler fail):', e));
      } catch (accessError) {
        // File likely already cleaned up or never existed, ignore
      }
    }

    res.status(500).json({
      error: 'Failed to unprotect PDF',
      details: error.message
    });
  }
};

module.exports = {
  listMergedPDFs,
  mergePDFs,
  splitPDF,
  downloadFile,
  compressPDF,
  imageToPDF,
  pdfToImage,
  protectPDF,
  unprotectPDF
};