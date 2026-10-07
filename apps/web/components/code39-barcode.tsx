"use client";

import { useMemo } from "react";

const PATTERNS: Record<string,string> = {
 "0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw","5":"wnnwwnnnn",
 "6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn","A":"wnnnnwnnw","B":"nnwnnwnnw",
 "C":"wnwnnwnnn","D":"nnnnwwnnw","E":"wnnnwwnnn","F":"nnwnwwnnn","G":"nnnnnwwnw","H":"wnnnnwwnn",
 "I":"nnwnnwwnn","J":"nnnnwwwnn","K":"wnnnnnnww","L":"nnwnnnnww","M":"wnwnnnnwn","N":"nnnnwnnww",
 "O":"wnnnwnnwn","P":"nnwnwnnwn","Q":"nnnnnnwwn","R":"wnnnnnwwn","S":"nnwnnnwwn","T":"nnnnwnwwn",
 "U":"wwnnnnnnw","V":"nwwnnnnnw","W":"wwwnnnnnn","X":"nwwnnnnwn","Y":"wwnnnnnwn","Z":"nwwnwnnnn",
 "-":"nwnnnnwnw",".":"wwnnnnwnn"," ":"nwwnnnwnn","$":"nwnwnwnnn","/":"nwnwnnnwn","+":"nwnnnwnwn","%":"nnnwnwnwn",
 "*":"nwnnwnwnn"
};

function encode(value:string){
 const clean=value.toUpperCase().replace(/[^0-9A-Z.\- $/+%]/g,"-");
 return ["*",...clean.split(""),"*"].map((char)=>PATTERNS[char]||PATTERNS["-"]);
}

export function Code39Barcode({ value, height=56 }: { value:string; height?:number }){
 const bars=useMemo(()=>encode(value),[value]);
 let x=8;
 const rects: {x:number;w:number}[]=[];
 for(const pattern of bars){
  for(let i=0;i<pattern.length;i++){
   const wide=pattern[i]==="w";
   const w=wide?3:1;
   if(i%2===0) rects.push({x,w});
   x+=w;
  }
  x+=1;
 }
 return (
  <svg role="img" aria-label={"Barcode "+value} viewBox={"0 0 "+(x+8)+" "+(height+24)} width="100%" height={height+24} preserveAspectRatio="none">
   <rect x="0" y="0" width="100%" height={height+24} fill="white"/>
   {rects.map((r,i)=><rect key={i} x={r.x} y="4" width={r.w} height={height} fill="black"/>)}
   <text x="50%" y={height+19} textAnchor="middle" fontFamily="monospace" fontSize="12" fill="black">{value}</text>
  </svg>
 );
}
