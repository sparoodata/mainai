const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');

// Load OAuth2 client credentials from credentials.json
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

// Function to authenticate with Google Drive
async function authenticate() {
    const content = fs.readFileSync(CREDENTIALS_PATH);
    const credentials = JSON.parse(content);

    // Handle both web and installed (desktop) credentials
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    
    if (!redirect_uris || redirect_uris.length === 0) {
        throw new Error("No redirect URIs found in credentials.json");
    }

    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKEN_PATH)) {
        const token = fs.readFileSync(TOKEN_PATH);
        oAuth2Client.setCredentials(JSON.parse(token));
    } else {
        await getAccessToken(oAuth2Client);
    }

    return oAuth2Client;
}

// Function to get the access token from the Google OAuth consent screen
function getAccessToken(oAuth2Client) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log('Authorize this app by visiting this URL:', authUrl);

    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve, reject) => {
        rl.question('Enter the code from that page here: ', (code) => {
            rl.close();
            oAuth2Client.getToken(code, (err, token) => {
                if (err) {
                    console.error('Error retrieving access token', err);
                    return reject(err);
                }
                oAuth2Client.setCredentials(token);
                // Store the token to disk for later program executions
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
                console.log('Token stored to', TOKEN_PATH);
                resolve(oAuth2Client);
            });
        });
    });
}

// Function to upload a file to Google Drive
async function uploadFileToGoogleDrive(auth, filePath, fileName) {
    const drive = google.drive({ version: 'v3', auth });
    const fileMetadata = {
        name: fileName,
        // Optionally, set your folder ID here:
        // parents: ['your-folder-id-on-drive'],
    };
    const media = {
        mimeType: 'image/jpeg', // Adjust this depending on the file type
        body: fs.createReadStream(filePath),
    };

    try {
        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
        });
        console.log('File uploaded to Google Drive, file ID:', response.data.id);
        return response.data.id;
    } catch (error) {
        console.error('Error uploading file to Google Drive:', error);
        throw new Error('Failed to upload file to Google Drive');
    }
}

module.exports = { authenticate, uploadFileToGoogleDrive };
