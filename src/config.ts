export const SITE = {
  website: "https://themanforfree.github.io/",
  author: "Neo",
  profile: "https://github.com/themanforfree",
  desc: "Neo 的个人博客。",
  title: "Neo's Blog",
  ogImage: "astropaper-og.jpg",
  lightAndDarkMode: true,
  postPerIndex: 4,
  postPerPage: 4,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true,
  editPost: {
    enabled: false,
    text: "Edit page",
    url: "https://github.com/themanforfree/themanforfree.github.io/edit/main/",
  },
  dynamicOgImage: true,
  dir: "ltr",
  lang: "zh-CN",
  timezone: "Asia/Shanghai",
} as const;
