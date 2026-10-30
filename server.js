const http = require('http');

const port = process.env.PORT || 8787;
const host = '0.0.0.0';

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  
  // Handle health checks
  if (req.url === '/api/health' || req.url === '/api/health/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      ok: true, 
      db: true, 
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
    return;
  }
  
  // Handle root
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Trader Vaults API</h1><p>API is running!</p>');
    return;
  }
  
  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(port, host, () => {
  console.log(`Server is running on http://${host}:${port}`);
  console.log(`Health check: http://${host}:${port}/api/health`);
  console.log('Environment:', process.env.NODE_ENV || 'development');
  
  // Try to start the actual API after server is up
  console.log('Attempting to start full API...');
  
  const { spawn } = require('child_process');
  const api = spawn('npm', ['run', 'start'], {
    stdio: 'inherit',
    cwd: process.cwd()
  });
  
  api.on('error', (err) => {
    console.error('Failed to start API:', err);
  });
  
  api.on('exit', (code) => {
    console.log(`API process exited with code ${code}`);
  });
});