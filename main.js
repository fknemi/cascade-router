const http = require('http');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    console.log('GOT REQUEST:', req.method, req.url);
    console.log('Headers:', req.headers);
    console.log('Body:', body.substring(0, 200));
    
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: 'ok'}));
  });
});

server.listen(3000, '0.0.0.0', () => {
  console.log('RAW server on 0.0.0.0:3000 - logging EVERYTHING');
});
