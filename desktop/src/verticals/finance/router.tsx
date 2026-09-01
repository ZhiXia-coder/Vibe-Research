import { createBrowserRouter, Navigate } from "react-router-dom";
import { Layout } from "@/components/layout/Layout";
import { Home } from "@/pages/Home";
import { DailyReview } from "@/pages/DailyReview";
import { Intel } from "@/pages/Intel";
import { Signals } from "@/pages/Signals";
import { Sectors } from "@/pages/Sectors";
import { SectorDetail } from "@/pages/SectorDetail";
import { Debate } from "@/pages/Debate";
import { Backtest } from "@/pages/Backtest";
import { Portfolio } from "@/pages/Portfolio";
import { Watchlist } from "@/pages/Watchlist";
import { Research } from "@/pages/Research";
import { MyReports } from "@/pages/MyReports";
import { Notes } from "@/pages/Notes";
import { Settings } from "@/pages/Settings";
import { AgentOps } from "@/pages/AgentOps";

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/daily-review", element: <DailyReview /> },
      { path: "/intel", element: <Intel /> },
      { path: "/intel/:tab", element: <Intel /> },
      { path: "/signals", element: <Signals /> },
      { path: "/signals/:tab", element: <Signals /> },
      { path: "/sectors", element: <Sectors /> },
      { path: "/sectors/:key", element: <SectorDetail /> },
      { path: "/portfolio", element: <Portfolio /> },
      // 旧版「个股研究」链接保留兼容，但产品里只有一个研究页。
      { path: "/stock-data", element: <Navigate replace to="/research" /> },
      { path: "/debate", element: <Debate /> },
      { path: "/backtest", element: <Backtest /> },
      { path: "/watchlist", element: <Watchlist /> },
      { path: "/research", element: <Research /> },
      { path: "/agent-ops", element: <AgentOps /> },
      { path: "/my-reports", element: <MyReports /> },
      { path: "/notes", element: <Notes /> },
      { path: "/settings", element: <Settings /> },
    ],
  },
]);
