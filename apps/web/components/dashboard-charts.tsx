"use client";
// Lightweight SVG charts for the home dashboard (2026-11-26 request).
// No chart library: pure SVG + CSS entry animations defined in globals.css
// (dashboard-chart-* classes), all motion disabled under prefers-reduced-motion.

export type TrendPoint={label:string;value:number};
export type DualTrendPoint={label:string;a:number;b:number};
export type Slice={label:string;value:number;color:string};
export type BarRow={label:string;sub?:string;value:number};

const W=560,H=180,PAD={top:14,right:10,bottom:24,left:10};

function points(values:number[],max:number){
 const innerW=W-PAD.left-PAD.right,innerH=H-PAD.top-PAD.bottom;
 const n=Math.max(1,values.length-1);
 return values.map((v,i)=>[PAD.left+innerW*i/n,PAD.top+innerH*(1-(max>0?v/max:0))] as const);
}
function pathFrom(pts:readonly (readonly [number,number])[]){return pts.map((p,i)=>(i===0?"M":"L")+p[0].toFixed(1)+","+p[1].toFixed(1)).join(" ")}

export function LineTrend({data,color}:{data:TrendPoint[];color:string}){
 if(!data.length)return <div className="empty">لا توجد بيانات.</div>;
 const max=Math.max(1,...data.map(x=>x.value));
 const pts=points(data.map(x=>x.value),max);
 const line=pathFrom(pts);
 const area=line+` L${(W-PAD.right).toFixed(1)},${(H-PAD.bottom).toFixed(1)} L${PAD.left.toFixed(1)},${(H-PAD.bottom).toFixed(1)} Z`;
 return <svg viewBox={`0 0 ${W} ${H}`} className="dashboard-svg" role="img">
  <path d={area} fill={color} opacity={0.12} className="dashboard-chart-fade"/>
  <path d={line} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" className="dashboard-chart-line"/>
  {pts.map((p,i)=><circle key={i} cx={p[0]} cy={p[1]} r={3.2} fill="var(--surface,#fff)" stroke={color} strokeWidth={2} className="dashboard-chart-fade"/>)}
  {pts.map((p,i)=><text key={"v"+i} x={p[0]} y={Math.max(10,p[1]-7)} textAnchor="middle" className="dashboard-svg-value">{data[i].value.toLocaleString("ar-EG")}</text>)}
  {data.map((x,i)=><text key={i} x={pts[i][0]} y={H-8} textAnchor="middle" className="dashboard-svg-label">{x.label}</text>)}
 </svg>;
}

export function DualLineTrend({data,colorA,colorB,legendA,legendB}:{data:DualTrendPoint[];colorA:string;colorB:string;legendA:string;legendB:string}){
 if(!data.length)return <div className="empty">لا توجد بيانات.</div>;
 const max=Math.max(1,...data.flatMap(x=>[x.a,x.b]));
 const ptsA=points(data.map(x=>x.a),max),ptsB=points(data.map(x=>x.b),max);
 return <div>
  <svg viewBox={`0 0 ${W} ${H}`} className="dashboard-svg" role="img">
   <path d={pathFrom(ptsA)} fill="none" stroke={colorA} strokeWidth={2.5} strokeLinejoin="round" className="dashboard-chart-line"/>
   <path d={pathFrom(ptsB)} fill="none" stroke={colorB} strokeWidth={2.5} strokeLinejoin="round" className="dashboard-chart-line"/>
   {ptsA.map((p,i)=><circle key={"a"+i} cx={p[0]} cy={p[1]} r={3} fill="var(--surface,#fff)" stroke={colorA} strokeWidth={2} className="dashboard-chart-fade"/>)}
   {ptsA.map((p,i)=><text key={"va"+i} x={p[0]} y={Math.max(10,p[1]-7)} textAnchor="middle" className="dashboard-svg-value">{data[i].a.toLocaleString("ar-EG")}</text>)}
   {ptsB.map((p,i)=><circle key={"b"+i} cx={p[0]} cy={p[1]} r={3} fill="var(--surface,#fff)" stroke={colorB} strokeWidth={2} className="dashboard-chart-fade"/>)}
   {data.map((x,i)=><text key={i} x={ptsA[i][0]} y={H-8} textAnchor="middle" className="dashboard-svg-label">{x.label}</text>)}
  </svg>
  <div className="dashboard-legend"><span><i style={{background:colorA}}/>{legendA}</span><span><i style={{background:colorB}}/>{legendB}</span></div>
 </div>;
}

export function MultiLineTrend({labels,series,colors}:{labels:string[];series:{name:string;values:number[]}[];colors:string[]}){
 if(!labels.length||!series.length)return <div className="empty">لا توجد بيانات.</div>;
 const max=Math.max(1,...series.flatMap(x=>x.values));
 return <div>
  <svg viewBox={`0 0 ${W} ${H}`} className="dashboard-svg" role="img">
   {series.map((sr,si)=>{
    const pts=points(sr.values,max);const color=colors[si%colors.length];
    return <g key={sr.name}>
     <path d={pathFrom(pts)} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" className="dashboard-chart-line"/>
     {pts.map((p,i)=><circle key={i} cx={p[0]} cy={p[1]} r={3} fill="var(--surface,#fff)" stroke={color} strokeWidth={2} className="dashboard-chart-fade"/>)}
    </g>;
   })}
   {labels.map((l,i)=><text key={i} x={points(labels.map(()=>0),1)[i][0]} y={H-8} textAnchor="middle" className="dashboard-svg-label">{l}</text>)}
  </svg>
  <div className="dashboard-legend">{series.map((sr,si)=><span key={sr.name}><i style={{background:colors[si%colors.length]}}/>{sr.name}</span>)}</div>
 </div>;
}

export function DonutChart({slices,centerLabel}:{slices:Slice[];centerLabel:string}){
 const total=slices.reduce((s,x)=>s+x.value,0);
 if(!slices.length||total<=0)return <div className="empty">لا توجد بيانات.</div>;
 const R=52,CIRC=2*Math.PI*R;
 let acc=0;
 return <div className="dashboard-donut-wrap">
  <svg viewBox="0 0 140 140" className="dashboard-donut" role="img">
   <circle cx={70} cy={70} r={R} fill="none" stroke="var(--border,#e8edf4)" strokeWidth={18}/>
   {slices.filter(x=>x.value>0).map(x=>{
    const frac=x.value/total,start=acc;acc+=frac;
    return <circle key={x.label} cx={70} cy={70} r={R} fill="none" stroke={x.color} strokeWidth={18}
     strokeDasharray={`${(frac*CIRC).toFixed(1)} ${CIRC.toFixed(1)}`} strokeDashoffset={(-start*CIRC).toFixed(1)}
     transform="rotate(-90 70 70)" className="dashboard-chart-donut-slice"/>;
   })}
   <text x={70} y={66} textAnchor="middle" className="dashboard-donut-value">{centerLabel}</text>
   <text x={70} y={84} textAnchor="middle" className="dashboard-donut-caption">الإجمالي</text>
  </svg>
  <div className="dashboard-legend-col">{slices.map(x=><span key={x.label}><i style={{background:x.color}}/>{x.label} · {x.value}</span>)}</div>
 </div>;
}

export function HBars({rows,color,format}:{rows:BarRow[];color:string;format:(v:number)=>string}){
 if(!rows.length)return <div className="empty">لا توجد بيانات.</div>;
 const max=Math.max(1,...rows.map(x=>x.value));
 return <div className="dashboard-hbars">{rows.map((x,i)=><div className="dashboard-hbar-row" key={x.label+i}>
  <div className="dashboard-hbar-head"><strong>{i+1}. {x.label}</strong>{x.sub&&<span>{x.sub}</span>}<b>{format(x.value)}</b></div>
  <div className="dashboard-hbar-track"><div className="dashboard-hbar-fill" style={{width:(x.value/max*100)+"%",background:color}}/></div>
 </div>)}</div>;
}

export function Gauge({ratio}:{ratio:number}){
 const pct=Math.max(0,Math.min(1,ratio));
 const R=52,CIRC=2*Math.PI*R;
 const color=pct>0.1?"#dc2626":pct>0.05?"#d97706":"#059669";
 return <div className="dashboard-donut-wrap">
  <svg viewBox="0 0 140 140" className="dashboard-donut" role="img">
   <circle cx={70} cy={70} r={R} fill="none" stroke="var(--border,#e8edf4)" strokeWidth={18}/>
   <circle cx={70} cy={70} r={R} fill="none" stroke={color} strokeWidth={18}
    strokeDasharray={`${(pct*CIRC).toFixed(1)} ${CIRC.toFixed(1)}`} transform="rotate(-90 70 70)" className="dashboard-chart-donut-slice"/>
   <text x={70} y={70} textAnchor="middle" className="dashboard-donut-value">{(pct*100).toFixed(1)}%</text>
   <text x={70} y={88} textAnchor="middle" className="dashboard-donut-caption">نسبة الهالك</text>
  </svg>
  <div className="dashboard-legend-col"><span><i style={{background:color}}/>آخر ٧ أيام من الإنتاج المعتمد</span></div>
 </div>;
}
