const crypto = require('crypto');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Initialize S3 client (Cloudflare R2)
const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Generate a unique unit ID
 * @returns {string} Unique unit ID in format U1234A
 */
const generateUnitId = () => {
  const prefix = 'U';
  const randomDigits = Math.floor(1000 + Math.random() * 9000);
  const randomLetter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${prefix}${randomDigits}${randomLetter}`;
};

/**
 * Generate a unique tenant ID
 * @returns {string} Unique tenant ID in format T1234A
 */
const generateTenantId = () => {
  const prefix = 'T';
  const randomDigits = Math.floor(1000 + Math.random() * 9000);
  const randomLetter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${prefix}${randomDigits}${randomLetter}`;
};

/**
 * Generate a unique upload token
 * @returns {string} Unique upload token
 */
const generateUploadToken = () => {
  return crypto.randomBytes(16).toString('hex');
};

/**
 * Upload file to R2 storage
 * @param {Object} file - File object from multer
 * @param {string} userId - User ID
 * @param {string} purpose - Purpose of upload (property, unit, tenant, document)
 * @returns {Promise<Object>} File metadata
 */
const uploadFileToR2 = async (file, userId, purpose) => {
  const fileContent = fs.readFileSync(file.path);
  const fileExtension = path.extname(file.originalname);
  const fileName = `${purpose}/${userId}/${Date.now()}${fileExtension}`;
  
  const params = {
    Bucket: process.env.R2_BUCKET_NAME,
    Key: fileName,
    Body: fileContent,
    ContentType: file.mimetype,
  };
  
  try {
    await s3Client.send(new PutObjectCommand(params));
    fs.unlinkSync(file.path); // Clean up temp file
    
    return {
      url: `${process.env.R2_PUBLIC_URL}/${fileName}`,
      filename: file.originalname,
      contentType: file.mimetype,
      size: file.size,
      uploadDate: new Date()
    };
  } catch (error) {
    console.error('Error uploading to R2:', error);
    throw error;
  }
};

/**
 * Generate thumbnail from image
 * @param {Buffer} imageBuffer - Image buffer
 * @param {number} width - Thumbnail width
 * @param {number} height - Thumbnail height
 * @returns {Promise<Buffer>} Thumbnail buffer
 */
const generateThumbnail = async (imageBuffer, width = 200, height = 200) => {
  try {
    return await sharp(imageBuffer)
      .resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .toBuffer();
  } catch (error) {
    console.error('Error generating thumbnail:', error);
    throw error;
  }
};

/**
 * Upload image with thumbnail to R2
 * @param {Object} file - File object from multer
 * @param {string} userId - User ID
 * @param {string} purpose - Purpose of upload (property, unit, tenant)
 * @returns {Promise<Object>} File metadata with thumbnail URL
 */
const uploadImageWithThumbnail = async (file, userId, purpose) => {
  if (!file.mimetype.startsWith('image/')) {
    return await uploadFileToR2(file, userId, purpose);
  }
  
  try {
    // Upload original image
    const fileMetadata = await uploadFileToR2(file, userId, purpose);
    
    // Generate thumbnail
    const fileContent = fs.readFileSync(file.path);
    const thumbnail = await generateThumbnail(fileContent);
    
    // Upload thumbnail
    const fileExtension = path.extname(file.originalname);
    const thumbnailFileName = `${purpose}/${userId}/thumbnails/${Date.now()}${fileExtension}`;
    
    const thumbnailParams = {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: thumbnailFileName,
      Body: thumbnail,
      ContentType: file.mimetype,
    };
    
    await s3Client.send(new PutObjectCommand(thumbnailParams));
    
    // Add thumbnail URL to metadata
    fileMetadata.thumbnailUrl = `${process.env.R2_PUBLIC_URL}/${thumbnailFileName}`;
    
    return fileMetadata;
  } catch (error) {
    console.error('Error uploading image with thumbnail:', error);
    throw error;
  } finally {
    // Clean up temp file
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  }
};

/**
 * Format error message for logging and response
 * @param {Error} error - Error object
 * @param {string} context - Context where error occurred
 * @returns {Object} Formatted error object
 */
const formatError = (error, context) => {
  const errorObj = {
    message: error.message,
    context,
    timestamp: new Date().toISOString(),
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
  };
  
  console.error(`[ERROR] ${context}:`, errorObj);
  
  return {
    error: errorObj.message,
    context
  };
};

module.exports = {
  generateUnitId,
  generateTenantId,
  generateUploadToken,
  uploadFileToR2,
  generateThumbnail,
  uploadImageWithThumbnail,
  formatError
};
