import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import OptimizerPage from './OptimizerPage';
import MarketResearchPage from './MarketResearchPage';
import './tailwind.css';
import './styles.css';
import './optimizer.css';

function Shell() {
  const [page,setPage]=useState(window.location.hash==='#optimizer'?'optimizer':window.location.hash==='#market'?'market':'workbench');
  useEffect(()=>{const onHash=()=>setPage(window.location.hash==='#optimizer'?'optimizer':window.location.hash==='#market'?'market':'workbench');window.addEventListener('hashchange',onHash);return()=>window.removeEventListener('hashchange',onHash);},[]);
  return <><nav className="module-nav" aria-label="工作台模块"><a href="#market" className={page==='market'?'selected':''}>行情研究</a><a href="#workbench" className={page==='workbench'?'selected':''}>策略工作台</a><a href="#optimizer" className={page==='optimizer'?'selected':''}>策略优化器</a></nav>{page==='market'?<MarketResearchPage/>:page==='optimizer'?<OptimizerPage/>:<App/>}</>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Shell /></React.StrictMode>);
