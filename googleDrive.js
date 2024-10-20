const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');

// Path to your credentials and token files
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

// Function to authenticate with Google Drive
async function authenticate() {
    // Load the OAuth2 client credentials from credentials.json
    const content = fs.readFileSync(CREDENTIALS_PATH);
    const credentials = JSON.parse(content);

    // Destructure client details from credentials
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;

    if (!redirect_uris || redirect_uris.length === 0) {
        throw new Error("No redirect URIs found in credentials.json");
    }

    // Create a new OAuth2 client
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    // Check if the token.json file exists and read it
    if (fs.existsSync(TOKEN_PATH)) {
        const token = fs.readFileSync(TOKEN_PATH);
        oAuth2Client.setCredentials(JSON.parse(token));
    } else {
        // If token.json does not exist, we get a new access token
        await getAccessToken(oAuth2Client);
    }

    return oAuth2Client;
}

// Function to get a new access token and store it in token.json
function getAccessToken(oAuth2Client) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline', // Allows for refresh tokens
        scope: ['https://www.googleapis.com/auth/drive.file'], // Scopes for Drive API
    });
    console.log('Authorize this app by visiting this URL:', authUrl);

    // Create a readline interface to receive the authorization code from the user
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve, reject) => {
        // Prompt the user to enter the authorization code from the consent screen
        rl.question('Enter the code from that page here: ', (code) => {
            rl.close();
            // Exchange the code for an access token
            oAuth2Client.getToken(code, (err, token) => {
                if (err) {
                    console.error('Error retrieving access token', err);
                    return reject(err);
                }
                // Set the credentials for the OAuth2 client
                oAuth2Client.setCredentials(token);
                // Store the token in token.json for future use
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
                console.log('Token stored to', TOKEN_PATH);
                resolve(oAuth2Client);
            });
        });
    });
}

// Function to upload a file to Google Drive
async function uploadFileToGoogleDrive(auth, filePath, fileName) {
    const drive = google.drive({ version: 'v3', auth }); // Initialize Drive API client
    const fileMetadata = {
        name: fileName,
        // Optionally, add the folder ID where you want to upload the file
        // parents: ['your-folder-id-on-drive'],
    };
    const media = {
        mimeType: 'image/jpeg', // Adjust this depending on your file type (e.g., 'image/png', 'application/pdf', etc.)
        body: fs.createReadStream(filePath), // Read the file from the file path
    };

    try {
        // Upload the file to Google Drive
        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id', // Only requesting the file ID in the response
        });
        console.log('File uploaded to Google Drive, file ID:', response.data.id);
        return response.data.id;
    } catch (error) {
        console.error('Error uploading file to Google Drive:', error);
        throw new Error('Failed to upload file to Google Drive');
    }
}

// Export the authenticate and upload functions
module.exports = { authenticate, uploadFileToGoogleDrive };
