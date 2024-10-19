const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');

// Load OAuth2 client credentials from credentials.json
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

async function authenticate() {
    const content = fs.readFileSync(CREDENTIALS_PATH);
    const credentials = JSON.parse(content);
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKEN_PATH)) {
        const token = fs.readFileSync(TOKEN_PATH);
        oAuth2Client.setCredentials(JSON.parse(token));
    } else {
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/drive.file'],
        });
        console.log('Authorize this app by visiting this url:', authUrl);
    }

    return oAuth2Client;
}

async function uploadFileToGoogleDrive(auth, filePath, fileName) {
    const drive = google.drive({ version: 'v3', auth });
    const fileMetadata = { name: fileName };

    const media = {
        mimeType: 'image/jpeg', // Adjust based on the file type
        body: fs.createReadStream(filePath),
    };

    const response = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id',
    });

    console.log('File uploaded to Google Drive, file id:', response.data.id);
    return response.data.id;
}

module.exports = { authenticate, uploadFileToGoogleDrive };
