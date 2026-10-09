"use client";

import { useMemo } from "react";

const PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232","2331112"
];

function encodeCode128B(value:string){
  const clean=value.replace(/[\u0000-\u001F]/g," ").slice(0,80);
  const codes=[104,...Array.from(clean).map(ch=>{
    const n=ch.charCodeAt(0)-32;
    return n>=0&&n<=95?n:0;
  })];
  let checksum=104;
  for(let i=1;i<codes.length;i++) checksum+=codes[i]*i;
  codes.push(checksum%103,106);
  return codes.map(c=>PATTERNS[c]);
}

export function Code128Barcode({value,height=54}:{value:string;height?:number}){
  const patterns=useMemo(()=>encodeCode128B(value),[value]);
  let x=4;
  const bars:{x:number;width:number}[]=[];
  for(const pattern of patterns){
    for(let i=0;i<pattern.length;i++){
      const width=Number(pattern[i]);
      if(i%2===0) bars.push({x,width});
      x+=width;
    }
  }
  return <svg role="img" aria-label={"Code 128 "+value} viewBox={`0 0 ${x+4} ${height+20}`} width="100%" height={height+20} preserveAspectRatio="none">
    <rect width="100%" height="100%" fill="#fff"/>
    {bars.map((bar,i)=><rect key={i} x={bar.x} y="2" width={bar.width} height={height} fill="#000"/>)}
    <text x="50%" y={height+16} textAnchor="middle" fontFamily="monospace" fontSize="10" fill="#111827">{value}</text>
  </svg>;
}
