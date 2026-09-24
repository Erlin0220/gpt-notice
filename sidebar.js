(() => {
  "use strict";
  const P = globalThis.ChatGPTProjects;
  const SETTING = "notice:sidebar-collapse-enabled";
  const LIMIT = "notice:shortcut-project-limit";
  const COOKIE = "oai-sidebar-sections";
  const HOST_ID = "gpt-notice-project-shortcuts";
  const LABELS = new Map([
    ["置顶", "favorites"], ["Pinned", "favorites"], ["Favorites", "favorites"],
    ["项目", "projects"], ["Projects", "projects"],
    ["聊天", "chats"], ["Chats", "chats"], ["Your chats", "chats"], ["最近", "chats"], ["Recent", "chats"]
  ]);
  const FALLBACK = {
    outer: "relative px-row-x group/nav-section",
    section: "group/sidebar-expando-section mb-[var(--sidebar-expanded-section-margin-bottom)]",
    header: "group/nav-section-title flex items-center justify-between gap-2 browser:h-9 browser:ps-2.5 pe-0.5 ps-2",
    titleWrap: "min-w-0 flex-1 text-base font-medium text-tertiary opacity-75 browser:leading-4.5",
    titleFlex: "flex min-w-0 flex-1",
    head: "group/section-toggle -ms-1 flex min-w-0 flex-1 items-center gap-1 rounded-md py-0.5 ps-1 pe-1 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring browser:h-9 cursor-interaction",
    title: "min-w-0 truncate",
    main: "group relative cursor-interaction text-sm hover:bg-primary-ghost-hover h-[var(--height-token-row)] sidebar-item focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring has-[[aria-haspopup=menu][aria-expanded=true]]:bg-primary-ghost-hover sidebar-row-focus group/folder-row flex items-center justify-between overflow-hidden text-default [contain-intrinsic-block-size:auto_var(--height-token-row)] [content-visibility:auto]",
    content: "flex min-w-0 flex-1 items-center",
    iconWrap: "flex shrink-0 items-center ps-1 pe-1 browser:pe-0",
    iconSlot: "-mx-[3px] flex icon-leading-slot size-[var(--height-token-row)] shrink-0 items-center justify-center browser:-mx-0.5",
    nameWrap: "flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap rounded-md py-1 pe-0 text-start text-base text-default",
    nameInner: "flex min-w-0 flex-1 items-center gap-0.5",
    actions: "flex max-w-[50%] min-w-0 gap-1 w-[var(--sidebar-row-menu-width,0px)] opacity-[var(--sidebar-row-action-opacity,0)] [overflow:var(--sidebar-row-menu-overflow,hidden)] group-focus-visible/folder-row:w-auto group-focus-visible/folder-row:overflow-visible group-focus-visible/folder-row:opacity-100 group-hover/folder-row:w-auto group-hover/folder-row:overflow-visible group-hover/folder-row:opacity-100 focus-within:w-auto focus-within:overflow-visible focus-within:opacity-100",
    actionSlot: "me-1.5 grid h-6 max-w-48 min-w-6 shrink grid-cols-1 items-center group-focus-visible/folder-row:w-6 group-hover/folder-row:w-6 w-[var(--sidebar-row-action-width,auto)]",
    actionReveal: "col-start-1 row-start-1 inline-flex justify-self-end opacity-[var(--sidebar-row-action-opacity,0)] group-focus-visible/folder-row:opacity-100 group-hover/folder-row:opacity-100",
    action: "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-inherit hover:bg-primary-ghost-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
    moreRow: "flex gap-1 h-9 after:block after:h-px after:content-[''] last:after:hidden",
    more: "Button-G93JGk [--button-font-weight:var(--font-weight-normal)] [--color-text-secondary-ghost:var(--color-text-tertiary)]"
  };
  const PROJECT_ICON_PATHS = {
    folder: [["M5.55933 2.14136C6.06479 2.14136 6.55777 2.30207 6.96655 2.59937L7.81812 3.21851C8.04741 3.38523 8.32368 3.47534 8.60718 3.47534H11.9666C13.2874 3.47534 14.3582 4.54606 14.3582 5.86694V11.4666C14.3582 12.7874 13.2874 13.8582 11.9666 13.8582H4.03296C2.71229 13.8579 1.64136 12.7873 1.64136 11.4666V4.53296C1.6416 3.21244 2.71244 2.1416 4.03296 2.14136H5.55933ZM2.69214 7.85913V11.4666C2.69214 12.2074 3.29219 12.8081 4.03296 12.8083H11.9666C12.7075 12.8083 13.3083 12.2075 13.3083 11.4666V7.85913H2.69214ZM4.03296 3.19214C3.29234 3.19238 2.69239 3.79234 2.69214 4.53296V6.80835H13.3083V5.86694C13.3083 5.12596 12.7075 4.52515 11.9666 4.52515H8.60718C8.10172 4.52515 7.60874 4.36541 7.19995 4.06812L6.34839 3.448C6.11917 3.28145 5.84268 3.19214 5.55933 3.19214H4.03296Z", true]],
    wrench: [["M13.1892 6.42334C13.1892 6.31859 13.1833 6.21512 13.1746 6.11279L12.1755 7.11279C11.2673 8.02099 9.79467 8.02099 8.88647 7.11279C7.97881 6.20472 7.97886 4.73282 8.88647 3.82471L9.88549 2.82471C9.78382 2.81611 9.68096 2.81105 9.5769 2.81104C7.58161 2.81104 5.96375 4.42808 5.96362 6.42334C5.96362 6.49931 5.96585 6.57522 5.97045 6.6499C5.99355 7.02499 6.01126 7.31651 6.01928 7.53369C6.02666 7.73353 6.0298 7.92837 6.00073 8.07764C5.98214 8.17293 5.96215 8.27259 5.92358 8.37451C5.88497 8.47648 5.83314 8.56421 5.78393 8.64795C5.65778 8.86248 5.43743 9.07648 5.15405 9.35986L3.10424 11.4106C2.69418 11.8209 2.69405 12.4858 3.10424 12.896C3.51444 13.3061 4.17936 13.306 4.58959 12.896L6.64037 10.8452C6.92364 10.5619 7.13779 10.3414 7.35229 10.2153C7.43595 10.1662 7.52386 10.1152 7.62573 10.0767C7.72761 10.0381 7.82734 10.0181 7.9226 9.99951C8.07189 9.97047 8.26671 9.9726 8.46655 9.97998C8.68377 9.988 8.97514 10.0067 9.35033 10.0298C9.42502 10.0344 9.50092 10.0366 9.5769 10.0366C11.5721 10.0364 13.1892 8.41856 13.1892 6.42334ZM14.239 6.42334C14.239 8.99846 12.152 11.0862 9.5769 11.0864C9.47938 11.0864 9.38204 11.0836 9.28588 11.0776C8.90478 11.0542 8.62864 11.0372 8.42748 11.0298C8.32751 11.0261 8.25313 11.0247 8.19799 11.0259C8.1435 11.027 8.1228 11.0308 8.1228 11.0308C8.01936 11.0509 8.00361 11.0565 7.99682 11.0591C7.98976 11.0618 7.97312 11.0685 7.88451 11.1206C7.81649 11.1606 7.71987 11.2511 7.38256 11.5884L5.33276 13.6382C4.51249 14.4585 3.18236 14.4584 2.36205 13.6382C1.54175 12.8179 1.54175 11.4878 2.36205 10.6675L4.41186 8.61768C4.74904 8.2805 4.83866 8.18374 4.87865 8.11572C4.93228 8.02447 4.93858 8.00924 4.94115 8.00244C4.94376 7.99553 4.94943 7.97926 4.96948 7.87646C4.96995 7.87261 4.97233 7.85123 4.97338 7.80225C4.97457 7.74705 4.97415 7.67194 4.97045 7.57178C4.96302 7.3707 4.94605 7.09506 4.9226 6.71436C4.91668 6.61819 4.91381 6.52086 4.91381 6.42334C4.91394 3.84818 7.00171 1.76025 9.5769 1.76025C9.92933 1.76029 10.2732 1.80001 10.6042 1.87451C10.6613 1.88736 10.7462 1.90612 10.8191 1.93115C10.8809 1.95238 10.9676 1.98826 11.0515 2.05713L11.1335 2.13721L11.1794 2.19775C11.2786 2.34332 11.3221 2.5261 11.2966 2.70068C11.2723 2.86726 11.1889 2.98477 11.1365 3.04932C11.0875 3.10945 11.0245 3.17198 10.9792 3.21729L9.62963 4.56689C9.13148 5.06504 9.13148 5.87246 9.62963 6.37061C10.1278 6.86865 10.9352 6.86872 11.4333 6.37061L12.783 5.021C12.8284 4.97557 12.8906 4.91177 12.9509 4.86279C13.0155 4.81035 13.133 4.72793 13.2996 4.70361L13.3747 4.69678C13.5257 4.69166 13.6777 4.73576 13.8025 4.8208L13.863 4.8667L13.9431 4.94873C14.0117 5.03235 14.0478 5.11848 14.0691 5.18018C14.0941 5.25296 14.1129 5.33794 14.1257 5.39502C14.2003 5.72622 14.239 6.07072 14.239 6.42334Z"]],
    kettlebell: [["M11.3563 1.47461C13.3486 1.47461 14.5565 3.67455 13.4872 5.35547L12.1581 7.44238C12.7643 8.28422 13.1228 9.31707 13.1229 10.4336C13.1228 11.8811 12.522 13.1898 11.5575 14.1211C11.2562 14.4119 10.8614 14.534 10.4911 14.5342H5.50571C5.13535 14.5342 4.74071 14.4118 4.43931 14.1211C3.47479 13.1898 2.87303 11.8811 2.8729 10.4336C2.87297 9.31563 3.23101 8.2809 3.83872 7.43848L2.51255 5.35547C1.44328 3.6746 2.65119 1.47473 4.64341 1.47461H11.3563ZM7.9979 6.35938C5.74763 6.35955 3.92386 8.18333 3.92368 10.4336C3.92382 11.5846 4.39976 12.6246 5.16782 13.3662C5.24011 13.4358 5.35711 13.4843 5.50571 13.4844H10.4911C10.6393 13.4842 10.7558 13.4356 10.828 13.3662C11.596 12.6246 12.073 11.5846 12.0731 10.4336C12.0729 8.18331 10.2482 6.35953 7.9979 6.35938ZM4.64341 2.52539C3.47962 2.52551 2.7745 3.8101 3.39927 4.79199L4.56626 6.62598C5.4747 5.80666 6.6784 5.30868 7.9979 5.30859C9.31849 5.30867 10.5219 5.8084 11.4305 6.62891L12.6004 4.79199C13.2253 3.81005 12.5202 2.52539 11.3563 2.52539H4.64341Z", true]],
    heart: [["M10.6227 1.79305C12.8594 1.72165 14.8406 3.53638 14.858 6.06746C14.8748 8.51826 13.0735 11.4653 8.37658 14.0763C8.14339 14.2058 7.85687 14.2058 7.62365 14.0763C2.92672 11.4653 1.12547 8.51827 1.14221 6.06746C1.15961 3.53656 3.14009 1.72192 5.37658 1.79305C6.2699 1.82155 7.18162 2.15182 7.99963 2.82625C8.81766 2.15167 9.72929 1.82161 10.6227 1.79305ZM10.6559 2.84286C9.96125 2.86514 9.21887 3.13745 8.53185 3.75496C8.23013 4.02618 7.77014 4.0261 7.46838 3.75496C6.78117 3.13725 6.03818 2.86502 5.34338 2.84286C3.71381 2.79093 2.20538 4.11696 2.19201 6.07528C2.17941 7.95025 3.56002 10.5775 7.99963 13.0821C12.4396 10.5774 13.8208 7.95033 13.8082 6.07528C13.7948 4.11689 12.2855 2.79083 10.6559 2.84286Z"]],
    terminal: [["M11.0002 8.9751C11.29 8.97537 11.5256 9.21071 11.5256 9.50049C11.5254 9.79011 11.2899 10.0256 11.0002 10.0259H8.66724C8.37741 10.0259 8.14205 9.79027 8.14185 9.50049C8.14185 9.21054 8.37729 8.9751 8.66724 8.9751H11.0002Z"],["M4.79517 6.1294C5.0002 5.92437 5.33233 5.92437 5.53736 6.1294L6.91919 7.51124C7.18921 7.78136 7.18927 8.21967 6.91919 8.48975L5.53736 9.87159C5.33234 10.0763 5.0001 10.0764 4.79517 9.87159C4.59025 9.66666 4.59045 9.33445 4.79517 9.1294L5.92408 8.00049L4.79517 6.87159C4.59025 6.66666 4.59045 6.33445 4.79517 6.1294Z"],["M11.1067 1.80811C11.4829 1.80811 11.7326 1.80696 11.9495 1.84131C13.0868 2.0216 13.9783 2.91392 14.1585 4.05127C14.1928 4.26806 14.1917 4.51713 14.1917 4.89307V11.1069C14.1917 11.4832 14.1928 11.7328 14.1585 11.9497C13.9782 13.0869 13.0866 13.9784 11.9495 14.1587C11.7326 14.1931 11.4829 14.1919 11.1067 14.1919H4.89283C4.51689 14.1919 4.26782 14.193 4.05103 14.1587C2.91367 13.9786 2.02136 13.087 1.84107 11.9497C1.80672 11.7328 1.80787 11.4832 1.80787 11.1069V4.89307C1.80786 4.51716 1.80677 4.26805 1.84107 4.05127C2.02123 2.9138 2.91355 2.02147 4.05103 1.84131C4.26781 1.80701 4.51691 1.80811 4.89283 1.80811H11.1067ZM4.89283 2.85889C4.47682 2.85889 4.32977 2.86027 4.21509 2.87842C3.5269 2.98742 2.98718 3.52715 2.87818 4.21534C2.86002 4.33002 2.85865 4.47706 2.85865 4.89307V11.1069C2.85865 11.5228 2.86007 11.67 2.87818 11.7847C2.98718 12.4729 3.5269 13.0126 4.21509 13.1216C4.32978 13.1397 4.47676 13.1421 4.89283 13.1421H11.1067C11.5226 13.1421 11.6698 13.1397 11.7844 13.1216C12.4726 13.0126 13.0123 12.4729 13.1213 11.7847C13.1395 11.67 13.1419 11.5229 13.1419 11.1069V4.89307C13.1418 4.477 13.1395 4.33003 13.1213 4.21534C13.0123 3.52715 12.4726 2.98742 11.7844 2.87842C11.6698 2.86031 11.5226 2.85889 11.1067 2.85889H4.89283Z", true]],
    function: [["M4.067968 12.00024V10.00024C4.067968 9.74248 3.933416 9.50208 3.709376 9.35184L3.607816 9.2924C3.23144 9.10624 2.668104 8.68656 2.667968 8.00024C2.667968 7.31372 3.231392 6.893464 3.607816 6.707272L3.709376 6.64868C3.93348 6.498448 4.06788 6.258032 4.067968 6.000248V4.000248C4.067968 2.946264 4.958144 2.134616 6 2.134616C6.293816 2.134616 6.532024 2.37284 6.532032 2.666648C6.532032 2.960464 6.293816 3.19868 6 3.19868C5.496256 3.19868 5.132032 3.582224 5.132032 4.000248V6.000248C5.131936 6.689288 4.746712 7.279072 4.192968 7.600248L4.079688 7.661184C3.959648 7.720552 3.861104 7.7932 3.799216 7.864304C3.739896 7.93248 3.732032 7.976808 3.732032 8.00024C3.732088 8.02376 3.74024 8.0676 3.799216 8.13544C3.861112 8.20648 3.959616 8.27992 4.079688 8.33928L4.192968 8.39944C4.746848 8.72064 5.132032 9.31104 5.132032 10.00024V12.00024C5.132168 12.392 5.452136 12.75344 5.907032 12.79712L6 12.80104L6.107032 12.812C6.349472 12.86144 6.531904 13.076 6.532032 13.33304C6.532032 13.59016 6.349504 13.80456 6.107032 13.85416L6 13.86512L5.806248 13.85568C4.850248 13.76256 4.068104 12.98808 4.067968 12.00024ZM10.868 12.00024V10.00024C10.868 9.26504 11.30656 8.64288 11.92032 8.33928L12.00624 8.2924C12.08744 8.24352 12.1544 8.18872 12.2008 8.13544C12.25976 8.0676 12.26792 8.02376 12.268 8.00024C12.268 7.976808 12.26008 7.93248 12.2008 7.864304C12.1544 7.811024 12.08736 7.75692 12.00624 7.708056L11.92032 7.661184C11.30656 7.357656 10.86808 6.73536 10.868 6.000248V4.000248C10.868 3.608416 10.54792 3.247112 10.09296 3.203368L10 3.19868L9.89296 3.187744C9.65048 3.1382 9.468 2.923792 9.468 2.666648C9.468 2.372832 9.70616 2.134616 10 2.134616L10.19376 2.143992C11.14984 2.237152 11.932 3.012264 11.932 4.000248V6.000248C11.93216 6.294824 12.10792 6.566688 12.39216 6.707272L12.54064 6.787744C12.90064 7.002216 13.332 7.399432 13.332 8.00024C13.33192 8.60088 12.90056 8.99752 12.54064 9.212L12.39216 9.2924C12.10784 9.43304 11.932 9.7056 11.932 10.00024V12.00024C11.93192 13.05408 11.04176 13.86512 10 13.86512C9.70616 13.86512 9.468 13.62688 9.468 13.33304C9.46808 13.03936 9.70624 12.80104 10 12.80104C10.5036 12.80104 10.86784 12.41816 10.868 12.00024Z"]],
    book: [["M11.9338 1.47461C12.5918 1.47479 13.1252 2.00896 13.1252 2.66699V11.3008C13.1368 11.4012 13.122 11.5072 13.0735 11.6074C12.9979 11.7636 12.7942 12.2363 12.7942 12.6689C12.7944 13.0701 12.9554 13.5014 13.0393 13.6943C13.2049 14.0758 12.9335 14.5273 12.4944 14.5273H4.60083C3.57441 14.5273 2.74172 13.6944 2.74146 12.668V4C2.74146 2.60556 3.87244 1.47474 5.26685 1.47461H11.9338ZM4.60083 11.8594C4.15414 11.8597 3.79235 12.2217 3.79224 12.668C3.7925 13.1143 4.15407 13.4765 4.60083 13.4766H11.8577C11.7949 13.2355 11.7445 12.9554 11.7444 12.6689C11.7444 12.3813 11.7972 12.0984 11.8645 11.8545L4.60083 11.8594ZM5.26685 2.52539C4.45234 2.52552 3.79224 3.18546 3.79224 4V10.9951C4.03662 10.8768 4.31023 10.8098 4.59985 10.8096L12.0754 10.8037V2.66699C12.0754 2.58886 12.0119 2.52557 11.9338 2.52539H5.26685Z", true]],
    books: [["M11.9338 1.47461C12.5918 1.47479 13.1252 2.00896 13.1252 2.66699V11.3008C13.1368 11.4012 13.122 11.5072 13.0735 11.6074C12.9979 11.7636 12.7942 12.2363 12.7942 12.6689C12.7944 13.0701 12.9554 13.5014 13.0393 13.6943C13.2049 14.0758 12.9335 14.5273 12.4944 14.5273H4.60083C3.57441 14.5273 2.74172 13.6944 2.74146 12.668V4C2.74146 2.60556 3.87244 1.47474 5.26685 1.47461H11.9338ZM4.60083 11.8594C4.15414 11.8597 3.79235 12.2217 3.79224 12.668C3.7925 13.1143 4.15407 13.4765 4.60083 13.4766H11.8577C11.7949 13.2355 11.7445 12.9554 11.7444 12.6689C11.7444 12.3813 11.7972 12.0984 11.8645 11.8545L4.60083 11.8594ZM5.26685 2.52539C4.45234 2.52552 3.79224 3.18546 3.79224 4V10.9951C4.03662 10.8768 4.31023 10.8098 4.59985 10.8096L12.0754 10.8037V2.66699C12.0754 2.58886 12.0119 2.52557 11.9338 2.52539H5.26685Z", true]],
    "graduation-cap": [["M7.19817 2.13549C7.70578 1.89234 8.29604 1.89234 8.80364 2.13549L14.9726 5.09155C15.793 5.48476 15.865 6.57942 15.1933 7.10034V9.99975C15.193 10.2894 14.9576 10.525 14.6679 10.5251C14.3781 10.5251 14.1428 10.2895 14.1425 9.99975V7.63744L12.8593 8.25268V10.5925C12.8591 11.4459 12.4278 12.2419 11.7128 12.7078L11.1992 13.0427C9.25534 14.3091 6.74649 14.3091 4.80267 13.0427L4.28899 12.7078C3.57418 12.2418 3.14275 11.4458 3.14251 10.5925V8.25268L1.02923 7.24096C0.126951 6.80862 0.127001 5.52393 1.02923 5.09155L7.19817 2.13549ZM8.80364 10.197C8.29617 10.44 7.70565 10.44 7.19817 10.197L4.19329 8.75659V10.5925C4.19353 11.0908 4.44488 11.5557 4.86224 11.8279L5.37591 12.1628C6.97132 13.2022 9.03051 13.2022 10.6259 12.1628L11.1396 11.8279C11.5572 11.5558 11.8093 11.0909 11.8095 10.5925V8.75659L8.80364 10.197ZM8.35052 3.08276C8.12967 2.97694 7.87214 2.97694 7.6513 3.08276L1.48235 6.03881C1.37549 6.09035 1.37536 6.24228 1.48235 6.29369L7.6513 9.24975C7.87209 9.3555 8.12973 9.35552 8.35052 9.24975L14.5195 6.29369C14.6264 6.24229 14.6263 6.09038 14.5195 6.03881L8.35052 3.08276Z", true]],
    brain: [["M9.99976 1.47574C10.6092 1.46931 11.2394 1.65976 11.7253 2.07438C12.1352 2.42408 12.4172 2.91548 12.5046 3.5236C14.37 4.0819 15.1029 6.40795 14.0007 7.95426C14.9969 9.3515 14.5283 11.4203 12.9529 12.2072C12.5781 13.539 11.4842 14.4094 10.325 14.5148C9.71768 14.57 9.09462 14.4133 8.57398 14.0031C8.35598 13.8313 8.16476 13.6181 7.99976 13.3693C7.83477 13.6181 7.64355 13.8313 7.42554 14.0031C6.9049 14.4133 6.28185 14.57 5.67457 14.5148C4.51521 14.4093 3.42041 13.5391 3.04566 12.2072C1.47086 11.42 1.00278 9.35127 1.99879 7.95426C0.896806 6.4082 1.62926 4.08238 3.4939 3.5236C3.58137 2.91542 3.86434 2.4241 4.27418 2.07438C4.76015 1.65976 5.39028 1.46931 5.99976 1.47574C6.60939 1.48225 7.23688 1.68576 7.71949 2.10953C7.8217 2.1993 7.91425 2.2994 7.99976 2.40641C8.08528 2.2994 8.17782 2.1993 8.28004 2.10953C8.76265 1.68576 9.39014 1.48225 9.99976 1.47574ZM7.47437 3.98063C7.47437 3.4732 7.28535 3.12621 7.02613 2.8986C6.75664 2.66202 6.38119 2.5297 5.98804 2.52555C5.5947 2.52146 5.22197 2.64613 4.95582 2.8732C4.70074 3.09087 4.51343 3.42699 4.51343 3.92692C4.51349 4.20888 4.30389 4.4328 4.04371 4.47281C2.65656 4.68651 2.05432 6.43651 2.95386 7.47574C3.19178 7.75064 3.19103 8.16032 2.95386 8.43473C2.172 9.33976 2.49823 10.8335 3.60718 11.3117C3.79063 11.3908 3.93363 11.543 4.00172 11.7306L4.02613 11.8136L4.07593 11.9953C4.35533 12.8837 5.08196 13.4064 5.76929 13.4689C6.1304 13.5018 6.48232 13.4094 6.77613 13.1779C7.06292 12.9518 7.32811 12.5638 7.47437 11.9445V3.98063ZM8.52515 11.9445C8.67141 12.5638 8.9366 12.9518 9.2234 13.1779C9.51721 13.4094 9.86913 13.5018 10.2302 13.4689C10.9632 13.4022 11.741 12.8124 11.9734 11.8136L11.9978 11.7306C12.0659 11.543 12.2089 11.3908 12.3923 11.3117L12.5916 11.2101C13.5379 10.6486 13.7786 9.28308 13.0457 8.43473C12.8085 8.16032 12.8078 7.75064 13.0457 7.47574L13.1257 7.37613C13.9068 6.32849 13.2996 4.67983 11.9558 4.47281C11.6947 4.43266 11.4846 4.20732 11.4861 3.92399C11.4854 3.42558 11.2983 3.09047 11.0437 2.8732C10.7776 2.64613 10.4048 2.52146 10.0115 2.52555C9.61834 2.5297 9.24289 2.66202 8.9734 2.8986C8.74651 3.09782 8.57262 3.38833 8.53297 3.79801L8.52515 3.98063V11.9445Z"]]
  };
  const THEME_COLORS = new Map([["#3A83F7", "#339CFF"], ["#53B559", "#40C977"], ["#FA423E", "#FF6764"]]);
  const COMPOSE_ICON_PATHS = [
    ["M6.33325 1.88379C6.58178 1.88379 6.78345 2.08546 6.78345 2.33398C6.78328 2.58237 6.58168 2.78418 6.33325 2.78418H4.66626C3.62638 2.78435 2.78362 3.62711 2.78345 4.66699V11.334C2.78361 12.3739 3.62637 13.2176 4.66626 13.2178H11.3333C12.3733 13.2178 13.2169 12.374 13.217 11.334V9.66699C13.2172 9.41872 13.418 9.21795 13.6663 9.21777C13.9147 9.21777 14.1163 9.41861 14.1165 9.66699V11.334C14.1163 12.871 12.8703 14.1172 11.3333 14.1172H4.66626C3.12932 14.117 1.88322 12.8709 1.88306 11.334V4.66699C1.88323 3.13006 3.12933 1.88396 4.66626 1.88379H6.33325Z"],
    ["M10.8948 2.375C11.6494 1.63227 12.8628 1.63698 13.6116 2.38574C14.362 3.13643 14.3637 4.35266 13.6165 5.10644L9.36353 9.39355C9.01402 9.74579 8.56977 9.98985 8.08521 10.0967L6.17603 10.5166C5.74813 10.6107 5.36686 10.2296 5.46118 9.80176L5.88208 7.89746C5.98978 7.4105 6.23578 6.96428 6.59106 6.61426L10.8948 2.375ZM12.9749 3.02148C12.5756 2.62258 11.9289 2.62086 11.5266 3.0166L7.2229 7.25586C6.99148 7.4839 6.83116 7.77457 6.76099 8.0918L6.44165 9.53711L7.89185 9.21777C8.20744 9.14811 8.49721 8.98919 8.72485 8.75976L12.9778 4.47266C13.3759 4.07066 13.375 3.42164 12.9749 3.02148Z", true]
  ];

  let enabled = null, limit = 8, pendingCollapse = "", previousNewChatKey = "";
  let cachedRaw = "", cachedProjects = [], cachedScope = "", documentScope = "", quarantinedScope = "";
  let host = null, body = null, signature = "", expanded = true, showAll = false;
  let lastRaw = null, lastUrl = "", lastScope = "";
  const nativeIconCache = new Map();

  function newChatKey(value = location.href) {
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin) return "";
      if (url.pathname === "/" || url.pathname === "") return "/";
      if (/\/project\/?$/.test(url.pathname) && P.route(url.href, url.origin)) return url.pathname.replace(/\/$/, "");
    } catch {}
    return "";
  }

  function preference() {
    try {
      const cookie = document.cookie.split("; ").find(value => value.startsWith(`${COOKIE}=`));
      const value = cookie ? JSON.parse(decodeURIComponent(cookie.slice(COOKIE.length + 1))) : { sectionStates: {} };
      return value && value.sectionStates && typeof value.sectionStates === "object" && !Array.isArray(value.sectionStates) ? value : null;
    } catch { return null; }
  }

  function writeCollapsedPreference() {
    const value = preference();
    if (!value) return;
    let changed = false;
    for (const key of ["favorites", "projects", "chats"]) {
      if (value.sectionStates[key] !== false) { value.sectionStates[key] = false; changed = true; }
    }
    if (changed) document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(value))}; Path=/; SameSite=Lax`;
  }

  function sectionButtons() {
    const found = new Map();
    for (const button of document.querySelectorAll('nav button[aria-expanded]')) {
      const key = LABELS.get((button.textContent || "").trim());
      if (key && !found.has(key)) found.set(key, button);
    }
    return found;
  }

  function sectionRoot(button) {
    for (let node = button?.parentElement; node && node.tagName !== "NAV"; node = node.parentElement) {
      if (node.classList?.contains("group/sidebar-expando-section") || node.classList?.contains("group/nav-section")) return node;
    }
    return button?.parentElement || null;
  }

  function sectionHeader(button) {
    for (let node = button?.parentElement; node && node.tagName !== "NAV"; node = node.parentElement) {
      if (node.classList?.contains("group/sidebar-expando-section-header") || node.classList?.contains("group/nav-section-title")) return node;
    }
    return button?.parentElement || null;
  }

  function finishPendingCollapse() {
    if (!pendingCollapse || enabled !== true) return;
    const buttons = sectionButtons();
    if (!["favorites", "projects", "chats"].every(key => buttons.has(key))) return;
    for (const key of ["favorites", "projects", "chats"]) {
      const button = buttons.get(key);
      if (button.getAttribute("aria-expanded") === "true") button.click();
    }
    if ([...buttons.values()].every(button => button.getAttribute("aria-expanded") === "false")) pendingCollapse = "";
  }

  function requestCollapse(value = location.href, force = false) {
    const key = newChatKey(value);
    if (enabled !== true || (!force && !key)) return;
    pendingCollapse = key || "initial";
    writeCollapsedPreference();
    finishPendingCollapse();
  }

  function sample(value = location.href) {
    const key = newChatKey(value);
    if (enabled === true && key && key !== previousNewChatKey) requestCollapse(value);
    previousNewChatKey = key;
    if (!key) pendingCollapse = "";
    finishPendingCollapse();
  }

  const SYMBOL = /^[a-z0-9-]+$/i;
  function spriteHref(value, expectedKind = "") {
    if (typeof value !== "string" || value.length > 500) return null;
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin || url.username || url.password || url.search) return null;
      const match = /^\/cdn\/assets\/sprites-(core|shell)-[a-z0-9._-]+\.svg$/i.exec(url.pathname), kind = match?.[1]?.toLowerCase() || "";
      const symbol = url.hash.slice(1);
      if (!match || expectedKind && kind !== expectedKind || symbol && !SYMBOL.test(symbol)) return null;
      return { kind, base: url.pathname, symbol };
    } catch { return null; }
  }
  function spriteBase(kind) {
    if (kind !== "core" && kind !== "shell") return "";
    for (const use of document.querySelectorAll("use[href]")) {
      const parsed = spriteHref(use.getAttribute("href") || "", kind);
      if (parsed) return parsed.base;
    }
    return "";
  }

  function setChevron() {
    const svg = host?.querySelector(".gn-chevron"), use = svg?.querySelector("use"), shell = spriteBase("shell");
    host?.querySelector(".gn-head")?.setAttribute("aria-expanded", String(expanded));
    if (body) body.hidden = !expanded;
    const header = host?.querySelector(".gn-header");
    if (header) header.dataset.state = expanded ? "open" : "closed";
    if (!svg) return;
    if (use && shell) {
      use.setAttribute("href", `${shell}#${expanded ? "chevron-down-sm" : "chevron-right-sm"}`);
      return;
    }
    svg.classList.toggle("-rotate-90", !expanded);
  }

  function createHost() {
    const node = document.createElement("section");
    node.id = HOST_ID;
    node.className = FALLBACK.outer;
    node.style.cssText = "min-width:0;max-width:100%;overflow-x:clip";
    const section = document.createElement("div"); section.className = `${FALLBACK.section} gn-section`;
    const header = document.createElement("div"); header.className = `${FALLBACK.header} gn-header`;
    const titleWrap = document.createElement("div"); titleWrap.className = `${FALLBACK.titleWrap} gn-title-wrap`;
    const titleFlex = document.createElement("div"); titleFlex.className = `${FALLBACK.titleFlex} gn-title-flex`;
    const head = document.createElement("button"); head.type = "button"; head.className = `${FALLBACK.head} gn-head`; head.setAttribute("aria-expanded", "true");
    const title = document.createElement("span"); title.className = `${FALLBACK.title} gn-title`; title.textContent = "快捷项目";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true"); svg.classList.add("gn-chevron");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); use.setAttribute("fill", "currentColor"); svg.append(use); head.append(title, svg); header.append(head);
    titleFlex.append(head); titleWrap.append(titleFlex); header.replaceChildren(titleWrap);
    body = document.createElement("ul"); body.className = "m-0 list-none p-0 gn-list"; body.style.cssText = "min-width:0;max-width:100%;overflow-x:clip";
    section.append(header, body); node.append(section);
    head.addEventListener("click", () => { expanded = !expanded; setChevron(); });
    return node;
  }

  function copyNativeSkin() {
    if (!host) return;
    const nativeButton = sectionButtons().get("projects"), native = sectionRoot(nativeButton);
    if (!nativeButton || !native || native === host) return;
    const nativeOuter = native.parentElement?.tagName === "SECTION" && native.parentElement.classList?.contains("group/nav-section") ? native.parentElement : null;
    host.className = `${nativeOuter?.className || FALLBACK.outer}`;
    const section = host.querySelector(".gn-section"); if (section) section.className = `${native.className || FALLBACK.section} gn-section`;
    const nativeHeader = sectionHeader(nativeButton), header = host.querySelector(".gn-header"), head = host.querySelector(".gn-head"), title = host.querySelector(".gn-title");
    if (nativeHeader?.className) header.className = nativeHeader.className;
    header.classList.add("gn-header");
    const nativeTitleFlex = nativeButton.parentElement, nativeTitleWrap = nativeTitleFlex?.parentElement;
    const titleFlex = host.querySelector(".gn-title-flex"), titleWrap = host.querySelector(".gn-title-wrap");
    if (nativeTitleWrap?.className) titleWrap.className = `${nativeTitleWrap.className} gn-title-wrap`;
    if (nativeTitleFlex?.className) titleFlex.className = `${nativeTitleFlex.className} gn-title-flex`;
    if (nativeButton.className) head.className = `${nativeButton.className} gn-head`;
    const nativeTitle = nativeButton.querySelector("h2, span");
    if (nativeTitle?.className) title.className = `${nativeTitle.className} gn-title`;
    const nativeChevron = nativeButton.querySelector("svg"), currentChevron = head.querySelector(".gn-chevron");
    if (nativeChevron && currentChevron && !currentChevron.matches('[data-native-chevron="true"]')) {
      const clone = nativeChevron.cloneNode(true); clone.classList.add("gn-chevron"); clone.dataset.nativeChevron = "true"; currentChevron.replaceWith(clone);
    }
  }

  function insertionPoint() {
    const buttons = sectionButtons(), chats = buttons.get("chats");
    if (!chats) return null;
    const chatsRoot = sectionRoot(chats);
    if (!chatsRoot) return null;
    const outer = chatsRoot.tagName === "SECTION" ? chatsRoot : chatsRoot.parentElement?.tagName === "SECTION" && chatsRoot.parentElement.classList?.contains("group/nav-section") ? chatsRoot.parentElement : chatsRoot;
    return outer.parentElement ? { container: outer.parentElement, anchor: outer } : null;
  }

  function mount() {
    const point = insertionPoint();
    if (!point) return false;
    if (!host) host = createHost();
    if (host.parentElement !== point.container || host.nextElementSibling !== point.anchor) point.container.insertBefore(host, point.anchor);
    copyNativeSkin(); setChevron();
    return true;
  }

  function nativeRowTemplate() {
    const native = sectionRoot(sectionButtons().get("projects"));
    const li = native?.querySelector('li [class~="group/project-unfurl-row"]')?.closest("li");
    if (li) return li;
    return native?.querySelector('[data-app-action-sidebar-project-row], .sidebar-item[role="button"]') || null;
  }

  function nativeRows() {
    const native = sectionRoot(sectionButtons().get("projects"));
    if (!native) return [];
    const current = [...native.querySelectorAll('[data-app-action-sidebar-project-row], .sidebar-item[role="button"]')]
      .filter(row => !row.closest(`#${HOST_ID}`) && row.querySelector('[data-marquee-text]'));
    const rows = current.length ? current : [...native.querySelectorAll('[class~="group/project-unfurl-row"] > [role="button"][data-sidebar-item="true"]')];
    for (const row of rows) captureNativeIcon(row);
    return rows;
  }

  function inlineSvg(paths, viewBox = "0 0 16 16") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("fill", "none"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", "icon-xs");
    for (const [d, evenodd] of paths || []) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d); path.setAttribute("fill", "currentColor");
      if (evenodd) { path.setAttribute("fill-rule", "evenodd"); path.setAttribute("clip-rule", "evenodd"); }
      svg.append(path);
    }
    return svg;
  }

  function nativeIconColor(row) {
    const svg = row?.querySelector("svg");
    if (!svg) return "";
    for (let node = svg.parentElement; node && node !== row; node = node.parentElement) {
      const inline = node.style?.color || "";
      if (inline) return inline;
    }
    const color = getComputedStyle(svg.parentElement || svg).color;
    return color && color !== "rgba(0, 0, 0, 0)" ? color : "";
  }

  function captureNativeIcon(row) {
    const projectId = row?.getAttribute("data-app-action-sidebar-project-id") || row?.dataset?.projectId || "";
    const svg = row?.querySelector("svg");
    if (!projectId || !svg) return;
    const clone = svg.cloneNode(true);
    clone.setAttribute("width", "16"); clone.setAttribute("height", "16"); clone.setAttribute("class", "icon-xs"); clone.setAttribute("aria-hidden", "true");
    nativeIconCache.set(projectId, { svg: clone, color: nativeIconColor(row) });
  }

  function visualOf(main) {
    const icon = main?.firstElementChild, svg = icon?.querySelector("svg"), use = svg?.querySelector("use[href]");
    if (!icon || !svg) return null;
    if (!use) return null;
    const parsed = spriteHref(use.getAttribute("href") || "");
    if (!parsed?.symbol) return null;
    const visual = { sprite: parsed.kind, symbol: parsed.symbol }, holder = icon.querySelector('[data-testid="project-folder-icon"]');
    const color = holder?.style?.color || "";
    if (color && color.length <= 32 && (!globalThis.CSS?.supports || CSS.supports("color", color))) visual.color = color;
    return visual;
  }

  function nativeRowFor(project) {
    const rows = nativeRows(), current = P.route(location.href, location.origin);
    const exact = rows.find(row => row.getAttribute("data-app-action-sidebar-project-id") === project.projectId);
    if (exact) return exact;
    if (current?.projectId === project.projectId) {
      const active = rows.find(row => row.hasAttribute("data-active"));
      if (active) return active;
    }
    return rows.find(row => row.querySelector('[data-marquee-text]')?.textContent?.trim() === project.name) || null;
  }

  function makeIcon(project) {
    const nativeMain = nativeRowFor(project);
    if (nativeMain) captureNativeIcon(nativeMain);
    const wrap = document.createElement("div"); wrap.className = FALLBACK.iconWrap;
    const slot = document.createElement("span"); slot.className = FALLBACK.iconSlot; slot.role = "presentation";
    const container = document.createElement("span"); container.className = "flex size-full items-center justify-center";
    const holder = document.createElement("span"); holder.className = "inline-flex shrink-0 items-center justify-center text-codex-icon"; holder.dataset.testid = "project-folder-icon";
    const cached = nativeIconCache.get(project.projectId), visual = project.visual;
    const color = cached?.color || visual?.color || THEME_COLORS.get((project.theme || "").toUpperCase()) || project.theme || "";
    if (color && (!globalThis.CSS?.supports || CSS.supports("color", color))) holder.style.color = color;
    holder.append(cached?.svg?.cloneNode(true) || inlineSvg(PROJECT_ICON_PATHS[project.emoji] || PROJECT_ICON_PATHS.folder));
    container.append(holder); slot.append(container); wrap.append(slot); return wrap;
  }

  function nameNode(project) {
    const wrap = document.createElement("div"); wrap.className = FALLBACK.nameWrap;
    const inner = document.createElement("span"); inner.className = FALLBACK.nameInner;
    const text = document.createElement("span"); text.dir = "auto"; text.className = "block min-w-0 flex-1 truncate select-none"; text.dataset.marqueeText = "true"; text.draggable = false; text.textContent = project.name;
    const tail = document.createElement("span"); tail.className = "flex shrink-0 items-center pe-2 empty:hidden";
    inner.append(text); wrap.append(inner, tail); return wrap;
  }

  function makeCompose(project) {
    const actions = document.createElement("div"); actions.className = FALLBACK.actions;
    const slot = document.createElement("div"); slot.className = FALLBACK.actionSlot;
    const reveal = document.createElement("span"); reveal.className = FALLBACK.actionReveal;
    const link = document.createElement("a"); link.className = FALLBACK.action; link.href = `/g/${project.shortUrl}/project`; link.target = "_blank"; link.rel = "noopener noreferrer"; link.dataset.projectNew = project.projectId;
    link.setAttribute("aria-label", `在 ${project.name} 中开启新聊天`); link.title = `在 ${project.name} 中开启新聊天`;
    link.addEventListener("click", event => event.stopPropagation());
    link.addEventListener("keydown", event => event.stopPropagation());
    link.append(inlineSvg(COMPOSE_ICON_PATHS)); reveal.append(link); slot.append(reveal); actions.append(slot); return actions;
  }

  function fallbackRow() {
    const li = document.createElement("li"); li.className = "list-none";
    const row = document.createElement("div"); row.className = "relative";
    const main = document.createElement("div"); main.className = FALLBACK.main; main.tabIndex = 0; main.role = "button"; main.dataset.fill = ""; main.dataset.sidebarItem = "true";
    main.style.cssText = "--menu-item-active:var(--interactive-bg-secondary-selected);--menu-item-background:var(--interactive-bg-secondary-default);--menu-item-highlighted:var(--interactive-bg-secondary-hover);--menu-item-open:var(--interactive-bg-secondary-press);--menu-item-pressed:var(--interactive-bg-secondary-press)";
    row.append(main); li.append(row); return li;
  }

  function projectRow(project, current) {
    const template = nativeRowTemplate();
    const li = fallbackRow();
    const row = li.querySelector('[class~="group/project-unfurl-row"]') || li.firstElementChild;
    const main = li.querySelector('[role="button"][data-sidebar-item="true"]');
    const currentTemplate = template?.matches?.('[data-app-action-sidebar-project-row], .sidebar-item[role="button"]') ? template : null;
    const templateRow = currentTemplate ? null : template?.querySelector('[class~="group/project-unfurl-row"]'), templateMain = currentTemplate || template?.querySelector('[role="button"][data-sidebar-item="true"]');
    if (!currentTemplate && template?.className) li.className = template.className;
    if (templateRow?.className) row.className = templateRow.className;
    if (templateMain?.className) main.className = templateMain.className;
    main.removeAttribute("aria-controls"); main.removeAttribute("aria-expanded"); main.removeAttribute("data-state"); main.removeAttribute("data-active"); main.dataset.projectId = project.projectId;
    if (currentTemplate) {
      main.removeAttribute("data-app-action-sidebar-project-collapsed"); main.removeAttribute("data-app-action-sidebar-project-id"); main.removeAttribute("data-app-action-sidebar-project-label"); main.removeAttribute("data-app-action-sidebar-project-row");
      const content = document.createElement("div"); content.className = currentTemplate.firstElementChild?.className || "flex min-w-0 flex-1 items-center"; content.replaceChildren(makeIcon(project), nameNode(project));
      const actions = makeCompose(project); if (currentTemplate.children[1]?.className) actions.className = currentTemplate.children[1].className;
      main.replaceChildren(content, actions);
    } else {
      const content = document.createElement("div"); content.className = FALLBACK.content; content.replaceChildren(makeIcon(project), nameNode(project));
      main.replaceChildren(content);
      main.append(makeCompose(project));
    }
    if (project.projectId === current?.projectId) main.dataset.active = "";
    main.setAttribute("aria-label", project.name); main.title = project.name;
    main.addEventListener("click", event => {
      if (event.target.closest?.("[data-project-new]")) return;
      location.assign(`/g/${project.shortUrl}/project`);
    });
    main.addEventListener("keydown", event => {
      if (event.target.closest?.("[data-project-new]")) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); location.assign(`/g/${project.shortUrl}/project`);
    });
    return li;
  }

  function moreRow() {
    const li = document.createElement("li"); li.className = FALLBACK.moreRow;
    const button = document.createElement("button");
    const nativeProject = sectionRoot(sectionButtons().get("projects"));
    const nativeMore = [...(nativeProject?.querySelectorAll("button") || [])].find(node => ["展开显示", "Show more"].includes((node.textContent || "").trim()));
    button.type = "button";
    if (nativeMore) {
      button.className = nativeMore.className;
      for (const name of ["data-color", "data-variant", "data-size"]) {
        const value = nativeMore.getAttribute(name); if (value) button.setAttribute(name, value);
      }
      button.innerHTML = nativeMore.innerHTML;
    } else {
      button.className = FALLBACK.more;
      button.dataset.color = "secondary"; button.dataset.variant = "transparent"; button.dataset.size = "xl";
      const inner = document.createElement("span"); inner.className = "ButtonInner-l31On4";
      const text = document.createElement("span"); text.className = "text-base"; text.textContent = document.documentElement.lang?.toLowerCase().startsWith("zh") ? "展开显示" : "Show more";
      inner.append(text); button.append(inner);
    }
    button.addEventListener("click", () => { showAll = true; signature = ""; render(lastRaw, lastUrl, lastScope); }); li.append(button); return li;
  }

  function render(raw, url = location.href, scope = "") {
    lastRaw = raw; lastUrl = url; lastScope = scope;
    if (!mount()) return;
    const projects = (raw?.items || []).map(P.normalize).filter(Boolean);
    host.hidden = !scope || projects.length === 0;
    if (host.hidden) return;
    const current = P.route(url, location.origin), hasTemplate = Boolean(nativeRowTemplate());
    const nextSignature = `${scope}:${raw?.revision || 0}:${current?.projectId || ""}:${showAll}:${limit}:${hasTemplate}:${nativeRows().length}:${spriteBase("core")}:${spriteBase("shell")}`;
    if (nextSignature === signature) return;
    signature = nextSignature;
    const visible = showAll ? projects : projects.slice(0, limit);
    body.replaceChildren(...visible.map(project => projectRow(project, current)));
    if (!showAll && projects.length > limit) body.append(moreRow());
    setChevron();
  }

  function collect(scope, url) {
    if (cachedScope !== scope) { cachedScope = scope; cachedRaw = ""; cachedProjects = []; }
    const raw = globalThis.ChatGPTPageAdapter.projectCache(scope);
    if (raw !== cachedRaw) { cachedRaw = raw; cachedProjects = P.fromCache(raw); }
    const found = new Map(cachedProjects.map(project => [project.projectId, project]));
    for (const row of nativeRows()) {
      const projectId = row.getAttribute("data-app-action-sidebar-project-id") || "", existing = found.get(projectId);
      if (!existing) continue;
      const name = row.getAttribute("data-app-action-sidebar-project-label") || row.querySelector('[data-marquee-text]')?.textContent?.trim() || existing.name;
      const visual = visualOf(row);
      found.set(projectId, { ...existing, name, ...(visual ? { visual } : {}) });
    }
    if (documentScope && documentScope !== scope) quarantinedScope = scope;
    documentScope = scope;
    const links = [...document.querySelectorAll('nav a[href*="/project"], header a[href*="/project"]')].filter(link => !link.closest(`#${HOST_ID}`));
    const foreignLink = quarantinedScope === scope && links.some(link => { const parsed = P.route(link.href, location.origin); return parsed && !found.has(parsed.projectId); });
    if (foreignLink) {
      const used = new Set();
      for (const row of nativeRows()) {
        const name = row.querySelector('[data-marquee-text]')?.textContent?.trim() || "";
        const match = [...found.values()].find(value => value.name === name && !used.has(value.projectId));
        const visual = visualOf(row);
        if (!match || !visual) continue;
        used.add(match.projectId);
        found.set(match.projectId, { ...match, visual });
      }
      return [...found.values()];
    }
    if (quarantinedScope === scope) quarantinedScope = "";
    for (const link of links) {
      const parsed = P.route(link.href, location.origin), label = link.querySelector('[data-marquee-text], .truncate');
      const name = (label?.textContent || link.getAttribute("title") || link.textContent || "").trim();
      const project = parsed && P.normalize({ ...parsed, name });
      if (project) found.set(project.projectId, { ...found.get(project.projectId), ...project, observedAt: 0 });
    }
    const current = P.route(url, location.origin);
    const title = /\/project\/?$/.test(new URL(url).pathname) && document.querySelector('main h1 [name="project-title"], main h1');
    const project = current && title && P.normalize({ ...current, name: title.textContent });
    if (project) found.set(project.projectId, { ...found.get(project.projectId), ...project, observedAt: 0 });
    const used = new Set();
    for (const row of nativeRows()) {
      const name = row.querySelector('[data-marquee-text]')?.textContent?.trim() || "";
      const match = row.hasAttribute("data-active") && current ? found.get(current.projectId) : [...found.values()].find(value => value.name === name && !used.has(value.projectId));
      const visual = visualOf(row);
      if (!match || !visual) continue;
      used.add(match.projectId);
      found.set(match.projectId, { ...match, visual });
    }
    return [...found.values()].slice(0, 500);
  }

  document.addEventListener("click", event => {
    const link = event.target.closest?.("a[href]");
    if (!link || link.closest(`#${HOST_ID}`) || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (newChatKey(link.href)) requestCollapse(link.href);
  }, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (Object.hasOwn(changes, SETTING)) {
      enabled = changes[SETTING].newValue !== false;
      if (enabled) requestCollapse(location.href, true); else pendingCollapse = "";
    }
    if (changes[LIMIT]) { limit = changes[LIMIT].newValue || 8; signature = ""; }
  });

  void chrome.storage.local.get([SETTING, LIMIT]).then(stored => {
    enabled = stored[SETTING] !== false;
    limit = stored[LIMIT] || 8;
    if (enabled) requestCollapse(location.href, true);
  }).catch(() => { enabled = false; });

  globalThis.ChatGPTSidebar = { sample, collect, render };
})();
