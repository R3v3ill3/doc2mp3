const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());
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

// Main concatenation endpoint - FIXED
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
