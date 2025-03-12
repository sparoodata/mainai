async function sendMessage() {
  const input = document.getElementById('message-input');
  const message = input.value.trim();
  if (!message) return;

  displayMessage('user', message);
  input.value = '';

  try {
    const response = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await response.json();
    displayMessage('assistant', data.reply);
  } catch (error) {
    console.error('Error:', error);
    displayMessage('assistant', 'Something went wrong!');
  }
}

function displayMessage(role, content) {
  const chatBox = document.getElementById('chat-box');
  const msgDiv = document.createElement('div');
  msgDiv.className = role === 'user' ? 'user-message' : 'bot-message';
  msgDiv.textContent = `${role === 'user' ? 'You' : 'Assistant'}: ${content}`;
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function suggest(text) {
  document.getElementById('message-input').value = text;
}

document.getElementById('message-input').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage();
});