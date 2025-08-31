// index.mjs
export const handler = awslambda.streamifyResponse(async (event, res) => {
  res.setContentType('text/event-stream');
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  send('message', { text: 'Hello' });
  await new Promise(r => setTimeout(r, 300));
  send('message', { text: 'from' });
  await new Promise(r => setTimeout(r, 300));
  send('message', { text: 'Lambda (ESM)!' });

  res.end();
});

