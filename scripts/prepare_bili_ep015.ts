import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const canvas = createCanvas(1280, 800), ctx = canvas.getContext('2d');
ctx.fillStyle = '#10131f'; ctx.fillRect(0, 0, 1280, 800);
ctx.textAlign = 'center';
ctx.font = 'bold 86px "Microsoft YaHei"'; ctx.fillStyle = '#ffffff';
ctx.fillText('猫猫斗蛐蛐', 640, 120);
ctx.font = 'bold 40px "Microsoft YaHei"'; ctx.fillStyle = '#ffd479';
ctx.fillText('分身越打越多  VS  并排双蛋', 640, 190);
const orange = await loadImage('public/memes/amigatito/idle.png');
const white = await loadImage('public/memes/jiujiu/idle.png');
const egg = await loadImage('public/memes/egg-projectile.png');
ctx.globalAlpha = 0.55;
ctx.drawImage(orange, 60, 290, 160, 240);
ctx.drawImage(orange, 420, 290, 160, 240);
ctx.globalAlpha = 1;
ctx.drawImage(orange, 200, 245, 240, 360);
ctx.drawImage(white, 780, 285, 350, 328);
ctx.drawImage(egg, 710, 245, 105, 105);
ctx.drawImage(egg, 825, 225, 105, 105);
ctx.font = 'bold 94px "Microsoft YaHei"'; ctx.fillStyle = '#ffdf88';
ctx.fillText('VS', 655, 480);
ctx.font = 'bold 38px "Microsoft YaHei"'; ctx.fillStyle = '#ffba57';
ctx.fillText('阿米嘎蒂朵猫猫', 325, 675);
ctx.fillStyle = '#8edfff'; ctx.fillText('九九成稀罕物', 970, 675);
ctx.font = '30px "Microsoft YaHei"'; ctx.fillStyle = '#aab3cb';
ctx.fillText('成长分身冲撞 · 实体双蛋命中', 640, 750);
fs.writeFileSync('exports/cover-ep015-bili.jpg', canvas.toBuffer('image/jpeg'));
fs.writeFileSync('exports/ep015-bili-metadata.json', JSON.stringify({
  video: 'exports/ep015-cat-meme-final.mp4',
  cover: 'exports/cover-ep015-bili.jpg',
  title: '【猫meme斗蛐蛐】阿米嘎蒂朵猫猫 VS 九九成稀罕物｜分身越打越多',
  desc: '35秒猫猫对战！橘猫每轮多一个分身，白猫并排发射双蛋，谁能赢？\n角色视频及原声来自用户提供的猫meme素材合集；战斗机制、画面编排和解说自制。解说使用豆包语音合成，蛋状道具由AI生成。',
  tags: '猫meme,电子斗蛐蛐,斗蛐蛐,搞笑,猫咪', tid: 138,
}, null, 2));
console.log('B站封面及投稿信息已生成');
