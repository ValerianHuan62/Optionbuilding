import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import OptimizerPage from './OptimizerPage';
import './tailwind.css';
import './styles.css';
import './optimizer.css';

function Shell() {
  const [page,setPage]=useState(window.location.hash==='#optimizer'?'optimizer':'workbench');
  useEffect(()=>{const onHash=()=>setPage(window.location.hash==='#optimizer'?'optimizer':'workbench');window.addEventListener('hashchange',onHash);return()=>window.removeEventListener('hashchange',onHash);},[]);
  return <><nav className="module-nav" aria-label="工作台模块"><a href="#workbench" className={page==='workbench'?'selected':''}>策略工作台</a><a href="#optimizer" className={page==='optimizer'?'selected':''}>执行价优化器 <span>NEW</span></a></nav>{page==='optimizer'?<OptimizerPage/>:<App/>}</>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Shell /></React.StrictMode>);
