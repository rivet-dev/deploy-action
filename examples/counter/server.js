import { createServer } from 'node:http';
import { actor, setup } from 'rivetkit';
import { createClient } from 'rivetkit/client';
const counter = actor({ state: { count: 0 }, actions: {
  increment(c) { return ++c.state.count; },
  getCount(c) { return c.state.count; }
} });
const registry = setup({ use: { counter } });
registry.start();
const client = createClient();
createServer(async (req, res) => {
  try {
    let body;
    if (req.url === '/increment') body = { count: await client.counter.getOrCreate(['smoke']).increment() };
    else if (req.url === '/count') body = { count: await client.counter.getOrCreate(['smoke']).getCount() };
    else body = { ok: true, version: 'vanilla', mode: process.env.NODE_ENV };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  } catch (error) { res.statusCode=500; res.end(JSON.stringify({error:String(error)})); }
}).listen(Number(process.env.PORT || 8080), '0.0.0.0');
createServer(async (req, res) => {
  const response = await registry.routes.prometheusMetrics();
  res.statusCode=response.status;
  res.end(await response.text());
}).listen(Number(process.env.RIVETKIT_METRICS_PORT || 9464), '127.0.0.1');
