const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Audiobook Concatenator Service Running' });
});

// Main concatenation endpoint
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

    // Create FFmpeg command
    let command = ffmpeg();
    
    // Add all input files
    sortedFiles.forEach(file => {
      command = command.input(file.path);
    });

    // Configure output
    command
      .on('start', (commandLine) => {
        console.log('FFmpeg started:', commandLine);
      })
      .on('progress', (progress) => {
        console.log('Processing: ' + progress.percent + '% done');
      })
      .on('end', () => {
        console.log('Concatenation finished');
        
        // Clean up input files
        sortedFiles.forEach(file => {
          fs.unlinkSync(file.path);
        });

        // Send the concatenated file
        res.download(outputPath, 'audiobook.mp3', (err) => {
          if (err) {
            console.error('Download error:', err);
          } else {
            // Clean up output file after download
            fs.unlinkSync(outputPath);
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
        
        res.status(500).json({ 
          error: 'Concatenation failed', 
          details: err.message 
        });
      })
      .audioCodec('mp3')
      .format('mp3')
      .save(outputPath);

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
});

app.listen(port, () => {
  console.log(`Audiobook concatenator service running on port ${port}`);
});
