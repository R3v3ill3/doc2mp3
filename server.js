const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fetch =require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

// PATCH APPLIED: Replaced the original cors() middleware with a more explicit one.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.json());

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Helper function to chunk text into segments under 4000 characters
function chunkText(text, maxChunkSize = 4000) {
  const chunks = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = '';
  let chunkIndex = 0;

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;

    // If adding this sentence would exceed the limit, save current chunk and start new one
    if (currentChunk.length + trimmedSentence.length + 1 > maxChunkSize) {
      if (currentChunk.trim()) {
        chunks.push({
          text: currentChunk.trim(),
          index: chunkIndex++
        });
        currentChunk = '';
      }
    }

    // If a single sentence is too long, split it by words
    if (trimmedSentence.length > maxChunkSize) {
      const words = trimmedSentence.split(' ');
      let wordChunk = '';
      
      for (const word of words) {
        if (wordChunk.length + word.length + 1 > maxChunkSize) {
          if (wordChunk.trim()) {
            chunks.push({
              text: wordChunk.trim(),
              index: chunkIndex++
            });
            wordChunk = '';
          }
        }
        wordChunk += (wordChunk ? ' ' : '') + word;
      }
      
      if (wordChunk.trim()) {
        currentChunk += (currentChunk ? ' ' : '') + wordChunk;
      }
    } else {
      currentChunk += (currentChunk ? ' ' : '') + trimmedSentence;
    }
  }

  // Add any remaining text as the final chunk
  if (currentChunk.trim()) {
    chunks.push({
      text: currentChunk.trim(),
      index: chunkIndex++
    });
  }

  return chunks;
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Audiobook Concatenator Service Running' });
});

// Document processing endpoint
app.post('/process-document', upload.single('document'), async (req, res) => {
  try {
    console.log('Received document processing request');
    
    if (!req.file) {
      return res.status(400).json({ error: 'No document file provided' });
    }

    const file = req.file;
    const filePath = file.path;
    let extractedText = '';

    console.log('Processing file:', file.originalname, 'Type:', file.mimetype);

    try {
      // Process different file types
      if (file.mimetype === 'application/pdf') {
        // Process PDF
        const dataBuffer = fs.readFileSync(filePath);
        const pdfData = await pdfParse(dataBuffer);
        extractedText = pdfData.text;
        
      } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        // Process DOCX
        const dataBuffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer: dataBuffer });
        extractedText = result.value;
        
      } else if (file.mimetype === 'text/plain') {
        // Process TXT
        extractedText = fs.readFileSync(filePath, 'utf8');
        
      } else {
        // Try to read as text for other file types
        extractedText = fs.readFileSync(filePath, 'utf8');
      }

      // Clean up the extracted text
      extractedText = extractedText
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();

      if (!extractedText || extractedText.length < 50) {
        return res.status(400).json({ 
          error: 'No readable text found in document or document is too short' 
        });
      }

      // Calculate word count
      const wordCount = extractedText.split(/\s+/).filter(word => word.length > 0).length;

      // Chunk the text
      const chunks = chunkText(extractedText);

      console.log(`Extracted ${wordCount} words, created ${chunks.length} chunks`);

      // Clean up uploaded file
      fs.unlinkSync(filePath);

      res.json({
        chunks,
        totalWordCount: wordCount,
        originalFileName: file.originalname,
        message: `Successfully processed ${file.originalname}: ${wordCount} words in ${chunks.length} chunks`
      });

    } catch (processingError) {
      console.error('Document processing error:', processingError);
      
      // Clean up file on error
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      
      res.status(500).json({ 
        error: 'Failed to process document', 
        details: processingError.message 
      });
    }

  } catch (error) {
    console.error('Server error:', error);
    
    // Clean up file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
});

// PATCH APPLIED: The 'end' event handler is updated to send a buffer instead of using res.download.
app.post('/concatenate-from-urls', async (req, res) => {
  try {
    console.log('Received concatenation request with URLs');
    
    const { audioUrls } = req.body;
    
    if (!audioUrls || !Array.isArray(audioUrls) || audioUrls.length === 0) {
      return res.status(400).json({ error: 'No audio URLs provided' });
    }

    console.log(`Downloading ${audioUrls.length} audio files from Firebase`);

    // Download all URLs to temporary files
    const downloadedFiles = [];
    const tempDir = path.join('uploads', `temp_${Date.now()}`);
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    try {
      for (let i = 0; i < audioUrls.length; i++) {
        const url = audioUrls[i];
        console.log(`Downloading file ${i + 1}/${audioUrls.length}: ${url}`);
        
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to download ${url}: ${response.statusText}`);
        }
        
        const buffer = await response.buffer();
        const filename = `chunk_${i.toString().padStart(3, '0')}.mp3`;
        const filePath = path.join(tempDir, filename);
        
        fs.writeFileSync(filePath, buffer);
        downloadedFiles.push({
          path: filePath,
          originalname: filename
        });
      }

      console.log(`Downloaded ${downloadedFiles.length} files successfully`);

      // Sort files by their index (they should already be sorted, but just in case)
      const sortedFiles = downloadedFiles.sort((a, b) => {
        const indexA = parseInt(a.originalname.match(/(\d+)/)?.[1] || '0');
        const indexB = parseInt(b.originalname.match(/(\d+)/)?.[1] || '0');
        return indexA - indexB;
      });

      const outputPath = path.join('uploads', `audiobook_${Date.now()}.mp3`);
      
      console.log(`Concatenating ${sortedFiles.length} files`);
      console.log('File order:', sortedFiles.map(f => f.originalname));

      // Create file list for FFmpeg concat demuxer
      const fileListPath = path.join(tempDir, 'filelist.txt');
      const fileListContent = sortedFiles
        .map(file => `file '${path.resolve(file.path)}'`)
        .join('\n');
      
      fs.writeFileSync(fileListPath, fileListContent);
      console.log('Created file list for FFmpeg');

      // Use FFmpeg concat demuxer
      ffmpeg()
        .input(fileListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .audioCodec('mp3')
        .format('mp3')
        .on('start', (commandLine) => {
          console.log('FFmpeg started:', commandLine);
        })
        .on('progress', (progress) => {
          console.log('Processing: ' + Math.round(progress.percent || 0) + '% done');
        })
        .on('end', () => {
          console.log('Concatenation finished successfully');
          // This section is modified based on the patch.
          try {
            // Read the concatenated file into a buffer
            const concatenatedBuffer = fs.readFileSync(outputPath);

            console.log(`Sending file as buffer (${concatenatedBuffer.length} bytes).`);

            // Set headers and send the buffer directly
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Disposition', 'attachment; filename="audiobook.mp3"');
            res.setHeader('Content-Length', concatenatedBuffer.length);
            
            res.send(concatenatedBuffer);

          } catch (readError) {
            console.error('Error reading concatenated file for sending:', readError);
            if (!res.headersSent) {
              res.status(500).json({ error: 'Failed to read final audio file', details: readError.message });
            }
          } finally {
            // Clean up all temporary files and the final output file
            if (fs.existsSync(tempDir)) {
              fs.rmSync(tempDir, { recursive: true, force: true });
            }
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
            }
          }
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          
          // Clean up temporary directory
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
          
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
          
          if (!res.headersSent) {
            res.status(500).json({ 
              error: 'Concatenation failed', 
              details: err.message 
            });
          }
        })
        .save(outputPath);

    } catch (downloadError) {
      console.error('Download error:', downloadError);
      
      // Clean up temporary directory
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      
      return res.status(500).json({ 
        error: 'Failed to download audio files', 
        details: downloadError.message 
      });
    }

  } catch (error) {
    console.error('Server error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Internal server error', 
        details: error.message 
      });
    }
  }
});

// Original concatenation endpoint - FIXED
app.post('/concatenate-audio', upload.array('audioFiles'), async (req, res) => {
  try {
    console.log('Received concatenation request');
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No audio files provided' });
    }

    // Sort files by their original index (assuming filename contains index)
    const sortedFiles = req.files.sort((a, b) => {
      const indexA = parseInt(a.originalname.match(/(\d+)/)?.[1] || '0');
      const indexB = parseInt(b.originalname.match(/(\d+)/)?.[1] || '0');
      return indexA - indexB;
    });

    const outputPath = path.join('uploads', `audiobook_${Date.now()}.mp3`);
    
    console.log(`Concatenating ${sortedFiles.length} files`);
    console.log('File order:', sortedFiles.map(f => f.originalname));

    // Create file list for FFmpeg concat demuxer
    const fileListPath = path.join('uploads', `filelist_${Date.now()}.txt`);
    const fileListContent = sortedFiles
      .map(file => `file '${path.resolve(file.path)}'`)
      .join('\n');
    
    fs.writeFileSync(fileListPath, fileListContent);
    console.log('Created file list:', fileListContent);

    // Use FFmpeg concat demuxer - this is the proper way to concatenate
    ffmpeg()
      .input(fileListPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .audioCodec('mp3')
      .format('mp3')
      .on('start', (commandLine) => {
        console.log('FFmpeg started:', commandLine);
      })
      .on('progress', (progress) => {
        console.log('Processing: ' + Math.round(progress.percent || 0) + '% done');
      })
      .on('end', () => {
        console.log('Concatenation finished successfully');
        
        // Clean up input files and file list
        sortedFiles.forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
        
        if (fs.existsSync(fileListPath)) {
          fs.unlinkSync(fileListPath);
        }

        // Send the concatenated file
        res.download(outputPath, 'audiobook.mp3', (err) => {
          if (err) {
            console.error('Download error:', err);
            if (!res.headersSent) {
              res.status(500).json({ error: 'Download failed', details: err.message });
            }
          } else {
            console.log('File sent successfully');
            // Clean up output file after download
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
            }
          }
        });
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        
        // Clean up files on error
        sortedFiles.forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
        
        if (fs.existsSync(fileListPath)) {
          fs.unlinkSync(fileListPath);
        }
        
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
        
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'Concatenation failed', 
            details: err.message 
          });
        }
      })
      .save(outputPath);

  } catch (error) {
    console.error('Server error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Internal server error', 
        details: error.message 
      });
    }
  }
});

app.listen(port, () => {
  console.log(`Audiobook concatenator service running on port ${port}`);
});
