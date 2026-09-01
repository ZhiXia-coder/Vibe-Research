import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import {
  Activity, ChevronDown, ChevronsLeft, ChevronsRight, Cog, Cpu, FileText, FlaskConical, Gauge, Github, GitBranch, Home, LayoutGrid, LineChart, Microscope, Moon, Newspaper, NotebookPen, Radar, Rss, Settings, Sparkles, Star, Sun, Swords, Thermometer, TrendingUp, UserRound, Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AiPageProvider } from "../../../../core/ai/pageContext";
import { FinanceAiConsole, FinanceAiDock } from "@/components/ui/FinanceAiDock";
import { useDarkMode } from "@/hooks/useDarkMode";
import { storageGet, storageSet } from "@/lib/storage";

// 具名导入：只把 version 打进产物，不会把整个 package.json 塞进 bundle
import { version as PKG_VERSION } from "../../../../../package.json";

// 版本号只从 package.json 读，不再各处写死（发 v0.3.0 时三处忘改停在 v0.2.2，#20）
const APP_VERSION = `v${PKG_VERSION}`;
const REPO_URL = "https://github.com/simonlin1212/Vibe-Research";
// 作者联系方式
const X_URL = "https://x.com/linsizhen";

const NAV = [
  { to: "/", icon: Home, label: "首页" },
  { to: "/daily-review", icon: Activity, label: "每日复盘" },
  { to: "/intel", icon: Radar, label: "资讯雷达" },
  { to: "/signals", icon: Thermometer, label: "产业信号" },
  { to: "/sectors", icon: LayoutGrid, label: "板块中心" },
  { to: "/research", icon: Microscope, label: "个股研究" },
  { to: "/agent-ops", icon: GitBranch, label: "Agent 运行" },
  { to: "/debate", icon: Swords, label: "多空辩论" },
  { to: "/backtest", icon: FlaskConical, label: "回测" },
  { to: "/watchlist", icon: Star, label: "自选股" },
  { to: "/portfolio", icon: Wallet, label: "我的持仓" },
  { to: "/my-reports", icon: FileText, label: "我的研报" },
  { to: "/notes", icon: NotebookPen, label: "研究记录" },
  { to: "/settings", icon: Settings, label: "接入 AI" },
];

// 资讯雷达的小栏目（缩进子项，顺序即页内 Tab 顺序）。
const INTEL_LINKS = [
  { to: "/intel/investment-news", icon: Rss, label: "Investment News" },
  { to: "/intel/news", icon: Newspaper, label: "公开新闻" },
  { to: "/intel/filings", icon: FileText, label: "A股公告" },
  { to: "/intel/events", icon: TrendingUp, label: "事件概率" },
];

// 产业信号的小栏目（缩进子项，逐期在此添加；带小三角可展开收起）。
const SIGNAL_LINKS = [
  { to: "/signals/gpu-rent", icon: Gauge, label: "GPU租金" },
];

// 常看的板块，作为「板块中心」下的快捷入口（缩进显示）。
// 板块中心下的快捷入口。🔴 只放**环节已核实**的那些 —— 指向空页面的入口比没有入口更糟:
// 用户点进去看到一片空白,分不清是"还没做"还是"坏了"。要加先把环节核实了。
const SECTOR_LINKS = [
  { to: "/sectors/humanoid", icon: Cog, label: "人形机器人" },
  { to: "/sectors/ai-computing", icon: Cpu, label: "AI 算力" },
];

// 带子栏目的导航组：父项右侧小三角展开/收起，展开状态按组记忆。
// 带子栏目的导航组。
// 🔴 存储键**带版本号**：默认值从"展开"改成"收起"时，老键里存着的 "open"
//    会让已经用过的人照旧全展开 —— 那不是 bug（它在记住你的选择），但新默认就等于没生效。
//    换个键 = 旧记忆不再适用，所有人重新从收起开始；之后手动展开的仍然会被记住。
const NAV_GROUPS: Record<string, { storageKey: string; links: typeof SIGNAL_LINKS }> = {
  "/intel": { storageKey: "vr-intel-open2", links: INTEL_LINKS },
  "/signals": { storageKey: "vr-signals-open2", links: SIGNAL_LINKS },
  "/sectors": { storageKey: "vr-sectors-open2", links: SECTOR_LINKS },
};

export function Layout() {
  const { pathname } = useLocation();
  const { dark, toggle } = useDarkMode();
  const navRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(() => storageGet("vr-sidebar") === "collapsed");
  // 底部 AI 控制台开着没。记住选择：它是"工作台的一部分"，不是弹一下就关的东西
  const [consoleOpen, setConsoleOpen] = useState(() => storageGet("vr-ai-console") === "open");
  const toggleConsole = () => {
    setConsoleOpen((v) => {
      storageSet("vr-ai-console", v ? "closed" : "open");
      return !v;
    });
  };
  const openAgent = () => {
    if (pathname === "/") {
      document.getElementById("home-agent")?.scrollIntoView({ behavior: "smooth", block: "center" });
      document.querySelector<HTMLTextAreaElement>('#home-agent textarea')?.focus({ preventScroll: true });
      return;
    }
    toggleConsole();
  };
  // 各导航组子栏目的展开状态（默认展开；按组记住用户的选择）
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    // 🔴 **默认收起**：一打开先看到一层干净的总览，要什么再展开。
    //    默认全展开时侧栏一屏塞十几条，一级栏目反而被子项淹掉。
    //    （`=== "open"` 而不是 `!== "closed"`：没存过就是收起。）
    Object.fromEntries(Object.entries(NAV_GROUPS).map(([path, g]) => [path, storageGet(g.storageKey) === "open"])));

  const toggleGroup = (path: string) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [path]: !prev[path] };
      storageSet(NAV_GROUPS[path]!.storageKey, next[path] ? "open" : "closed");
      return next;
    });
  };

  useEffect(() => {
    storageSet("vr-sidebar", collapsed ? "collapsed" : "expanded");
  }, [collapsed]);

  // 品牌区与 Agent 入口都是固定高度，导航本身会滚动。窗口偏矮时当前页可能刚好落在
  // 可视区外（例如最底部的「接入 AI」只露出一条边）—— 路由变化后把当前项拉回视野。
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const n = nav.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    const breathingRoom = 8;
    if (a.top < n.top + breathingRoom) nav.scrollTop -= n.top + breathingRoom - a.top;
    if (a.bottom > n.bottom - breathingRoom) nav.scrollTop += a.bottom - (n.bottom - breathingRoom);
  }, [pathname, collapsed]);

  return (
    <AiPageProvider>
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className={cn(
        "glass z-10 m-2 flex shrink-0 flex-col rounded-2xl transition-all duration-200",
        collapsed ? "w-14" : "w-60",
      )}>
        {/* Brand */}
        <div className={cn("border-b border-border/50", collapsed ? "flex justify-center p-3" : "p-4")}>
          <Link to="/" className={cn("flex items-center", collapsed ? "justify-center" : "gap-2")}>
            <LineChart className="h-6 w-6 shrink-0 text-primary text-glow" />
            {!collapsed && (
              <span className="text-lg font-extrabold tracking-tight">
                Vibe-<span className="text-primary">Research</span>
              </span>
            )}
          </Link>
          {!collapsed && (
            <>
              <p className="mt-1 text-[11px] text-muted-foreground">本地金融研究 Agent · A股/美股/港股</p>
              <div
                data-testid="codex-harness-badge"
                className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/[0.07] px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.8)]" />
                Built on Codex Harness
              </div>
            </>
          )}
        </div>

        {/* Nav */}
        <nav ref={navRef} className={cn("flex-1 space-y-1 overflow-auto", collapsed ? "p-1.5" : "p-2.5")}>
          {NAV.map(({ to, icon: Icon, label }) => {
            const active = pathname === to;
            const group = NAV_GROUPS[to];
            const groupOpen = group ? openGroups[to] : false;
            return (
              <div key={to}>
                <Link
                  to={to}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? label : undefined}
                  className={cn(
                    "flex items-center rounded-lg text-sm transition-colors",
                    collapsed ? "justify-center p-2.5" : "gap-2.5 px-3 py-2.5",
                    active
                      ? "bg-primary/15 font-medium text-primary shadow-glow"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && (group ? <span className="flex-1">{label}</span> : label)}
                  {/* 导航组：小三角展开/收起子栏目（点三角不跳转，点文字仍进总览页） */}
                  {group && !collapsed && (
                    <span
                      role="button"
                      aria-label={groupOpen ? "收起子栏目" : "展开子栏目"}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleGroup(to); }}
                      className="-mr-1 rounded p-0.5 hover:bg-muted/60"
                    >
                      <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !groupOpen && "-rotate-90")} />
                    </span>
                  )}
                </Link>

                {/* 子栏目（缩进）；收起侧栏时恒显示图标入口 */}
                {group && (groupOpen || collapsed) && (
                  <div className={cn("mt-1 space-y-0.5", !collapsed && "ml-4 border-l border-border/40 pl-1.5")}>
                    {group.links.map(({ to: st, icon: SIcon, label: slabel }) => {
                      const sactive = pathname === st;
                      return (
                        <Link
                          key={st}
                          to={st}
                          title={collapsed ? slabel : undefined}
                          className={cn(
                            "flex items-center rounded-lg transition-colors",
                            collapsed ? "justify-center p-2" : "gap-2 px-2.5 py-1.5 text-[13px]",
                            sactive
                              ? "bg-primary/10 font-medium text-primary"
                              : "text-muted-foreground/80 hover:bg-muted/40 hover:text-foreground",
                          )}
                        >
                          <SIcon className="h-3.5 w-3.5 shrink-0" />
                          {!collapsed && slabel}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* 🔴 AI 入口 —— **刻意与上面那些导航项长得不一样**：它不是"再一个页面"，
            而是把底部控制台推上来的开关。
            ⚠️ 早先是实心橙 + 纯白字：够显眼，但在这套玻璃质感的暗色界面里显得生硬
            （Simon：「橙色加白色有点傻」）。现在改成**橙作强调、不作底色**：
            很淡的橙色渐变底 + 细橙环 + 橙图标 + 常规前景色文字，
            打开时只把这几样各自加重一档，并给图标一个极缓的呼吸 —— 灵动但不吵。 */}
        <div className={cn(collapsed ? "px-1.5 pb-1.5" : "px-2.5 pb-2.5")}>
          <button
            onClick={openAgent}
            title={pathname === "/" ? "转到首页 Agent" : consoleOpen ? "收起 Agent" : "打开 Agent"}
            aria-pressed={pathname === "/" ? undefined : consoleOpen}
            className={cn(
              "group relative flex w-full items-center overflow-hidden rounded-xl",
              "font-medium tracking-wide transition-all duration-300",
              "bg-gradient-to-br from-primary/[0.18] via-primary/[0.10] to-transparent",
              "text-foreground/90 ring-1 ring-inset",
              collapsed ? "justify-center p-2" : "gap-2.5 px-3 py-2.5 text-sm",
              pathname === "/" || consoleOpen
                ? "ring-primary/50 shadow-[0_0_18px_-4px_hsl(var(--primary)/0.55)] text-foreground"
                : "ring-primary/25 hover:ring-primary/45 hover:from-primary/[0.26] hover:via-primary/[0.14]",
            )}
          >
            {/* 掠过的高光：只在悬停时走一次，给它一点"活气"而不是一直在动 */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 -left-full w-1/2 skew-x-12 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent transition-[left] duration-700 ease-out group-hover:left-full"
            />
            <Sparkles
              className={cn(
                "h-4 w-4 shrink-0 text-primary transition-transform duration-300",
                pathname === "/" || consoleOpen ? "animate-[pulse_2.4s_ease-in-out_infinite]" : "group-hover:scale-110",
              )}
            />
            {!collapsed && <span className="text-glow">Agent</span>}
            {!collapsed && (
              // 小标做成一枚淡色胶囊,而不是压透明度的白字 —— 后者在浅色主题下几乎看不见
              <span className={cn(
                "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-normal transition-colors",
                pathname === "/" || consoleOpen ? "bg-primary/20 text-primary" : "bg-foreground/[0.06] text-muted-foreground",
              )}>
                {pathname === "/" ? "首页" : consoleOpen ? "收起" : "对话"}
              </span>
            )}
          </button>
        </div>

        {/* Footer */}
        <div className={cn("border-t border-border/50", collapsed ? "flex flex-col items-center gap-2 p-2" : "space-y-2 p-3")}>
          {collapsed ? (
            <>
              <button onClick={toggle} className="rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground" title={dark ? "亮色" : "暗色"}>
                {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
              <a href={X_URL} target="_blank" rel="noreferrer" className="rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground" title="联系作者 · X @linsizhen">
                <UserRound className="h-4 w-4" />
              </a>
              <button onClick={() => setCollapsed(false)} className="rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground" title="展开">
                <ChevronsRight className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <button onClick={toggle} className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                  {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                  {dark ? "亮色" : "暗色"}
                </button>
                <div className="flex items-center gap-2">
                  <a href={X_URL} target="_blank" rel="noreferrer" className="text-muted-foreground transition-colors hover:text-foreground" title="联系作者 · X @linsizhen">
                    <UserRound className="h-3.5 w-3.5" />
                  </a>
                  <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-muted-foreground transition-colors hover:text-foreground" title="GitHub">
                    <Github className="h-3.5 w-3.5" />
                  </a>
                  <button onClick={() => setCollapsed(true)} className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground" title="收起">
                    <ChevronsLeft className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground/60">
                {APP_VERSION} · 不荐股 · 不预测 · 无倾向
              </p>
            </>
          )}
        </div>
      </aside>

      {/* Main —— 🔴 上下两块：内容在上、AI 控制台在下。
          控制台打开时是把内容**挤上去**（flex 收缩），不是盖在上面：
          这块面板的用处就是"一边看着页面一边聊"，浮层会把正在看的表格盖住。 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <main className="flex-1 overflow-auto">
          {/* 🔴 右上角那个固定的 AI 按钮会压在这一片上，所以留出它的宽度 ——
              不留的话，窄窗口下它会盖住页面自己的操作按钮（刷新之类），而宽窗口下看不出问题。 */}
          <div className="mx-auto max-w-6xl px-6 py-6 pr-24">
            <Outlet />
          </div>
        </main>
        {pathname !== "/" && <FinanceAiConsole open={consoleOpen} onClose={toggleConsole} />}
      </div>

      {/* 每一页都有的 AI 入口：位置固定，聊的是当前页登记的上下文 */}
      {pathname !== "/" && <FinanceAiDock />}
    </div>
    </AiPageProvider>
  );
}
