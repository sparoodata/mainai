const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const Jimp = require('jimp');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Initialize S3 client for Cloudflare R2
const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || ''
  }
});

/**
 * Generate a unique ID with prefix
 * @param {string} prefix - ID prefix
 * @returns {string} Unique ID
 */
function generateId(prefix = '') {
  // Using simple uuid generation compatible with Node.js 16
  const uniqueId = uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
  return `${prefix}${uniqueId}`;
}

/**
 * Generate a unique unit ID
 * @returns {string} Unique unit ID
 */
function generateUnitId() {
  const uniqueId = uuidv4().replace(/-/g, '').substring(0, 4).toUpperCase();
  const suffix = String.fromCharCode(65 + Math.floor(Math.random() * 26)); // A-Z
  return `U${uniqueId}${suffix}`;
}

/**
 * Generate a unique tenant ID
 * @returns {string} Unique tenant ID
 */
function generateTenantId() {
  const uniqueId = uuidv4().replace(/-/g, '').substring(0, 4).toUpperCase();
  const suffix = String.fromCharCode(65 + Math.floor(Math.random() * 26)); // A-Z
  return `T${uniqueId}${suffix}`;
}

/**
 * Upload image to R2 storage and generate thumbnail
 * @param {Buffer} buffer - Image buffer
 * @param {string} filename - Original filename
 * @param {string} contentType - Content type of the file
 * @returns {Promise<Object>} Object with URLs and metadata
 */
async function uploadImageWithThumbnail(buffer, filename, contentType) {
  try {
    // Generate unique IDs for the files
    const imageId = generateId('img');
    const thumbnailId = generateId('thumb');
    
    // Get file extension
    const extension = path.extname(filename).toLowerCase() || '.jpg';
    
    // Original image key
    const imageKey = `images/${imageId}${extension}`;
    
    // Upload original image
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: imageKey,
      Body: buffer,
      ContentType: contentType,
      Metadata: {
        originalFilename: filename
      }
    }));
    
    // Generate thumbnail using Jimp (Node.js 16 compatible)
    const image = await Jimp.read(buffer);
    const thumbnail = image.clone().resize(200, Jimp.AUTO);
    const thumbnailBuffer = await thumbnail.getBufferAsync(contentType);
    
    // Thumbnail key
    const thumbnailKey = `thumbnails/${thumbnailId}${extension}`;
    
    // Upload thumbnail
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: thumbnailKey,
      Body: thumbnailBuffer,
      ContentType: contentType,
      Metadata: {
        originalFilename: `thumb_${filename}`
      }
    }));
    
    // Generate public URLs
    const publicUrl = `${process.env.R2_PUBLIC_URL}/${imageKey}`;
    const thumbnailUrl = `${process.env.R2_PUBLIC_URL}/${thumbnailKey}`;
    
    return {
      url: publicUrl,
      thumbnailUrl: thumbnailUrl,
      filename: filename
    };
  } catch (error) {
    console.error('Error uploading image:', error);
    throw new Error('Failed to upload image');
  }
}

module.exports = {
  generateId,
  generateUnitId,
  generateTenantId,
  uploadImageWithThumbnail
};
