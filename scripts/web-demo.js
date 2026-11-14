import 'dotenv/config';
import {spawn} from 'node:child_process';
const children=['core','middle','frontend'].map(name=>spawn(process.execPath,[`src/web-demo/${name}.js`],{stdio:'inherit',env:process.env}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{children.forEach(c=>c.kill(signal));});
children.forEach(c=>c.on('exit',code=>{if(code)children.forEach(other=>other.kill());}));
