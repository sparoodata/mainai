// controllers/imageController.js
const AWS = require('aws-sdk');
const axios = require('axios');
const Image = require('../models/Image');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Tenant = require('../models/Tenant');

const { sendMessage, sendSummary } = require('./webhookController');

// S3/R2 config
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});

async function uploadImageAndSave(req, res) {
  const { phoneNumber, type, id } = req.params;
  const { token } = req.body;
  console.log(`POST request - Token: ${token}, File: ${req.file ? req.file.originalname : 'No file'}`);

  try {
    // 1) Upload to R2
    const key = `images/${Date.now()}-${req.file.originalname}`;
    const uploadParams = {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };
    await s3.upload(uploadParams).promise();

    // 2) Generate a pre-signed URL
    const signedUrl = s3.getSignedUrl('getObject', {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Expires: 300, // 5 minutes
    });
    console.log(`Image uploaded, signed URL generated: ${signedUrl}`);

    // 3) Save the image record
    const image = new Image({ [`${type}Id`]: id, imageUrl: key });
    await image.save();

    // 4) Update parent (Property/Unit/Tenant)
    if (type === 'property') {
      const property = await Property.findById(id);
      property.images.push(image._id);
      await property.save();
    } else if (type === 'unit') {
      const unit = await Unit.findById(id);
      unit.images.push(image._id);
      await unit.save();
    } else if (type === 'tenant') {
      const tenant = await Tenant.findById(id);
      tenant.photo = signedUrl; // or store `key`
      await tenant.save();
    }

    // 5) Send summary
    await sendSummary(phoneNumber, type, id, signedUrl);

    // 6) Mark token as used
    req.uploadToken.used = true;
    await req.uploadToken.save();

    res.send('Image uploaded successfully!');
  } catch (error) {
    console.error('Error uploading image:', error);
    // Optionally short-link for retry
    try {
      const retryUrl = `${process.env.GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${id}?token=${token}`;
      const shortUrl = await axios
        .post(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(retryUrl)}`)
        .then((r) => r.data);

      await sendMessage(phoneNumber, `❌ *Error*\nFailed to upload image. Please try again: ${shortUrl}`);
    } catch (shortErr) {
      console.error('Error creating short URL:', shortErr);
    }
    res.status(500).send('Error uploading image.');
  }
}

module.exports = {
  uploadImageAndSave,
};
