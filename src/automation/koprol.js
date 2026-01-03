const { Builder, By, until, Key } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const fs = require("fs");
const path = require("path");
const config = require("../utils/config");
const logger = require("../utils/logger");
const {
  guessTitle,
  guessHelpdeskNote,
  guessBobot,
} = require("../utils/ticketAnalysis");

class KoprolAutomation {
  constructor(options = {}) {
    this.driver = null;
    this.isLoggedIn = false;

    // Kredensial default dari config, bisa dioverride per-instance (misal per user WA)
    this.username = options.username || config.koprol.username;
    this.password = options.password || config.koprol.password;
  }

  xpathLiteral(text = "") {
    const str = `${text}`;
    if (!str.includes("'")) {
      return `'${str}'`;
    }
    const parts = str.split("'");
    const concat = parts
      .map((part) => `'${part}'`)
      .join(`, "\"'\"", `);
    return `concat(${concat})`;
  }

  async selectBobotDropdown(modal, value) {
    if (!value) return false;
    let row;
    try {
      row = await modal.findElement(
        By.xpath(
          ".//tr[.//label[contains(normalize-space(.), 'Bobot')] or .//td[contains(normalize-space(.), 'Bobot')] or .//td[contains(normalize-space(.), 'Difficulty')]]"
        )
      );
    } catch (e) {
      return false;
    }

    let input = null;
    const inputs = await row.findElements(
      By.css("input.o_input.ui-autocomplete-input, .o_input_dropdown input.o_input, input")
    );
    if (inputs.length) {
      input = inputs[0];
    }
    if (!input) return false;

    await this.scrollIntoView(input);
    try {
      await input.click();
    } catch (e) {}
    await this.driver.sleep(150);

    try {
      await input.clear().catch(() => {});
    } catch (e) {}
    await input.sendKeys(value);
    await this.driver.sleep(300);

    // Confirm selection to avoid o_field_invalid
    try {
      await input.sendKeys(Key.RETURN);
      await this.driver.sleep(350);
      return true;
    } catch (e) {
      return false;
    }
  }

  async selectUrgencyDropdown(scope, value) {
    if (!value) return false;
    let row = null;
    try {
      row = await scope.findElement(
        By.xpath(
          ".//*[self::tr or self::div][.//label[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'urgency') or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'urgensi')] or .//td[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'urgency') or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'urgensi')] or .//*[@data-fieldname='urgency']]"
        )
      );
    } catch (e) {}
    if (!row) {
      try {
        row = await scope.findElement(By.css("[data-fieldname='urgency']"));
      } catch (e) {
        return false;
      }
    }

    // Prefer explicit dropdown button
    let btn = null;
    const dropdownBtns = await row.findElements(
      By.css(".o_dropdown_button, .fa-chevron-down, .fa-caret-down, button")
    );
    if (dropdownBtns.length) {
      btn = dropdownBtns[0];
    }

    // If no button, try input directly
    const inputs = await row.findElements(
      By.css("input.o_input, input[type='text'], input:not([type])")
    );

    if (btn) {
      await this.scrollIntoView(btn);
      try {
        await btn.click();
      } catch (e) {}
      await this.driver.sleep(200);
    } else if (inputs.length) {
      // No dropdown button, go straight to input
      try {
        await this.scrollIntoView(inputs[0]);
        await inputs[0].click();
      } catch (e) {}
    }

    // Attempt pick from opened menu
    const itemXpath = `//div[contains(@class,'o_menu_opened')]//a[normalize-space(.)='${value}'] | //ul[contains(@class,'dropdown-menu') and contains(@class,'show')]//a[normalize-space(.)='${value}']`;
    try {
      const item = await this.driver.findElement(By.xpath(itemXpath));
      await item.click();
      await this.driver.sleep(250);
      return true;
    } catch (e) {}

    // Fallback: type then Enter
    if (inputs.length) {
      const input = inputs[0];
      await this.scrollIntoView(input).catch(() => {});
      try {
        await input.click();
      } catch (e) {}
      try {
        await input.clear();
      } catch (e) {}
      await input.sendKeys(value);
      await this.driver.sleep(200);
      try {
        await input.sendKeys(Key.RETURN);
        await this.driver.sleep(250);
      } catch (e) {}
      return true;
    }

    return false;
  }

  async initialize() {
    try {
      const options = new chrome.Options();

      if (config.selenium.headless) {
        options.addArguments("--headless");
      }

      options.addArguments("--disable-gpu");
      options.addArguments("--no-sandbox");
      options.addArguments("--disable-dev-shm-usage");
      options.addArguments("--window-size=1920,1080");

      this.driver = await new Builder()
        .forBrowser("chrome")
        .setChromeOptions(options)
        .build();

      logger.info("Selenium WebDriver initialized");
      return true;
    } catch (error) {
      logger.error("Failed to initialize WebDriver", error);
      throw error;
    }
  }

  async isOnLoginPage() {
    if (!this.driver) return false;
    try {
      const url = await this.driver.getCurrentUrl();
      if (url && url.includes("/web/login")) {
        return true;
      }
    } catch (e) {}

    try {
      const loginInputs = await this.driver.findElements(
        By.css(
          'form[action*="/web/login"], input[name="login"], input[placeholder="Email"], input[type="email"]'
        )
      );
      if (loginInputs.length) {
        return true;
      }
    } catch (e) {}

    return false;
  }

  async login() {
    if (this.isLoggedIn) {
      logger.info("Already logged in to Koprol");
      return true;
    }

    try {
      if (!this.driver) {
        await this.initialize();
      }

      if (!this.username || !this.password) {
        throw new Error(
          "Kredensial Koprol tidak lengkap. Pastikan username dan password sudah diisi."
        );
      }

      logger.info(`Navigating to ${config.koprol.url}/web/login`);
      await this.driver.get(`${config.koprol.url}/web/login`);

      // Wait for any email/login input to appear
      await this.driver.wait(
        until.elementLocated(
          By.css(
            'input[name="login"], input[placeholder="Email"], input[type="email"], input[type="text"]'
          )
        ),
        10000
      );

      // Find email/login field with fallbacks
      let emailField;
      try {
        emailField = await this.driver.findElement(
          By.css('input[name="login"]')
        );
      } catch (e1) {
        emailField = await this.driver.findElement(
          By.css(
            'input[placeholder="Email"], input[type="email"], input[type="text"]'
          )
        );
      }

      // Find password field with fallbacks
      let passwordField;
      try {
        passwordField = await this.driver.findElement(
          By.css('input[name="password"]')
        );
      } catch (e2) {
        passwordField = await this.driver.findElement(
          By.css('input[placeholder="Password"], input[type="password"]')
        );
      }

      await emailField.clear();
      await emailField.sendKeys(this.username);
      await passwordField.clear();
      await passwordField.sendKeys(this.password);

      // Trigger submit via ENTER on password to reduce chance of not logging in
      try {
        await passwordField.sendKeys(Key.RETURN);
        await this.driver.sleep(300);
      } catch (e) {}

      // Optional: click login button if we can find it (but don't fail if not found)
      let loginButton = null;
      try {
        // Common case: submit button element
        loginButton = await this.driver.findElement(
          By.css('button[type="submit"], input[type="submit"]')
        );
      } catch (e3) {
        try {
          // Fallback: any button with Login/Sign in text
          loginButton = await this.driver.findElement(
            By.xpath(
              "//button[contains(normalize-space(.), 'Log in') or contains(normalize-space(.), 'Login') or contains(normalize-space(.), 'Sign in')]"
            )
          );
        } catch (e4) {
          // If button truly not found, rely solely on ENTER we already sent
          logger.warn('Login button not found, relying on ENTER key for submit');
        }
      }

      if (loginButton) {
        try {
          await loginButton.click();
          await this.driver.sleep(1000);
        } catch (e) {
          logger.warn('Click on login button failed, relying on ENTER submit', e.message || e);
        }
      }

      // Wait until we are no longer on the login page and backend UI is visible
      const loginTimeoutMs = 20000;
      const startTs = Date.now();
      while (Date.now() - startTs < loginTimeoutMs) {
        const stillOnLogin = await this.isOnLoginPage();
        if (!stillOnLogin) break;
        await this.driver.sleep(500);
      }

      if (await this.isOnLoginPage()) {
        throw new Error("Masih di halaman login setelah submit kredensial");
      }

      try {
        await this.driver.wait(
          until.elementLocated(
            By.css(".o_main_navbar, .o_control_panel, .o_web_client")
          ),
          15000
        );
      } catch (e) {}

      this.isLoggedIn = true;
      logger.info("Successfully logged in to Koprol");
      return true;
    } catch (error) {
      logger.error("Login failed", error);
      throw new Error(
        "Gagal login ke Koprol. Periksa kembali kredensial Koprol yang diberikan."
      );
    }
  }

  async waitForAnyCss(selectors, timeout = 15000) {
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < timeout) {
      for (const sel of selectors) {
        try {
          const el = await this.driver.findElement(By.css(sel));
          if (await el.isDisplayed()) {
            return el;
          }
        } catch (e) {
          lastErr = e;
        }
      }
      await this.driver.sleep(250);
    }
    throw lastErr || new Error("Element not found: " + selectors.join(" | "));
  }

  async waitUntilSelectorsGone(selectors = [], timeout = 10000) {
    if (!selectors.length) return true;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let anyVisible = false;
      for (const sel of selectors) {
        const elements = await this.driver.findElements(By.css(sel));
        for (const el of elements) {
          try {
            if (await el.isDisplayed()) {
              anyVisible = true;
              break;
            }
          } catch (e) {}
        }
        if (anyVisible) break;
      }
      if (!anyVisible) {
        return true;
      }
      await this.driver.sleep(200);
    }
    return false;
  }

  async dismissAnyModal(timeout = 4000) {
    const modalSelectors = [
      ".modal.show",
      ".o_dialog_container .modal-content",
      ".o_legacy_dialog.modal.show",
    ];
    const btnSelectors = [
      "button.btn-primary",
      "button.btn-secondary",
      "button.btn",
      ".btn-primary",
      ".btn-secondary",
    ];

    const start = Date.now();
    while (Date.now() - start < timeout) {
      const modals = await this.driver.findElements(By.css(modalSelectors.join(",")));
      if (!modals.length) return true;
      for (const modal of modals) {
        let clicked = false;
        for (const bs of btnSelectors) {
          const btns = await modal.findElements(By.css(bs));
          if (btns.length) {
            try {
              await btns[0].click();
              clicked = true;
              break;
            } catch (e) {}
          }
        }
        if (!clicked) {
          try {
            const closes = await modal.findElements(By.css(".close, .o_close_button, [data-dismiss='modal']"));
            if (closes.length) {
              await closes[0].click();
            }
          } catch (e) {}
        }
      }
      await this.waitUntilSelectorsGone(modalSelectors, 1500);
      await this.driver.sleep(150);
    }
    return true;
  }

  async scrollIntoView(element) {
    if (!this.driver || !element) {
      return;
    }
    try {
      await this.driver.executeScript(
        "if (arguments[0] && arguments[0].scrollIntoView) { arguments[0].scrollIntoView({behavior:'instant', block:'center', inline:'nearest'}); }",
        element
      );
      await this.driver.sleep(200);
    } catch (e) {}
  }

  async waitForPageReady() {
    try {
      await this.driver.wait(
        until.elementLocated(By.css(".o_control_panel, .o_searchview")),
        15000
      );
    } catch (e) {}
    await this.driver.sleep(300);
  }

  async waitForUrlContains(fragment, timeout = 10000) {
    try {
      await this.driver.wait(until.urlContains(fragment), timeout);
    } catch (e) {}
  }

  async getSearchInputForTitle(titleText) {
    // Find the control panel whose breadcrumb contains the given title
    const cp = await this.driver.findElement(
      By.xpath(
        `//div[contains(@class,'o_control_panel')][.//ol[contains(@class,'breadcrumb')]//li[contains(normalize-space(.), '${titleText}')]]`
      )
    );
    // Within that control panel, find the search input
    try {
      return await cp.findElement(
        By.css("div.o_searchview_input_container input")
      );
    } catch (e1) {}
    try {
      return await cp.findElement(By.css("input.o_searchview_input"));
    } catch (e2) {}
    try {
      return await cp.findElement(
        By.css('input[placeholder="Search..."], input[type="search"]')
      );
    } catch (e3) {}
    throw new Error("Request Form search input not found");
  }

  async isRequestFormListVisible() {
    const listEls = await this.driver.findElements(
      By.css("table.o_list_table, .o_list_renderer")
    );
    if (!listEls.length) return false;
    const breadcrumb = await this.driver.findElements(
      By.xpath(
        "//div[contains(@class,'o_control_panel')]//ol[contains(@class,'breadcrumb')]//li[contains(normalize-space(.), 'Request Form')]"
      )
    );
    return breadcrumb.length > 0;
  }

  async selectJrfMenuOption(optionText) {
    const menuTriggerXPaths = [
      "//nav//*[self::a or self::button][contains(@class,'dropdown') or contains(@class,'o_menu_entry')][contains(normalize-space(.), 'JRF/ARF')]",
      "//a[contains(@class,'dropdown-toggle')][contains(., 'JRF/ARF')]",
      "//button[contains(., 'JRF/ARF')]",
    ];
    for (const xp of menuTriggerXPaths) {
      const els = await this.driver.findElements(By.xpath(xp));
      if (els.length) {
        try {
          await els[0].click();
          await this.driver.sleep(200);
          break;
        } catch (e) {}
      }
    }
    const optionXpath = `//a[normalize-space(.)='${optionText}' or contains(normalize-space(.), '${optionText}')]`;
    const options = await this.driver.findElements(By.xpath(optionXpath));
    if (options.length) {
      try {
        await options[0].click();
        await this.driver.sleep(400);
        return true;
      } catch (e) {}
    }
    return false;
  }

  async fillTitleFieldInAssignModal(modal, value) {
    if (!value) return false;
    let row;
    try {
      row = await modal.findElement(
        By.xpath(
          ".//tr[.//label[contains(normalize-space(.), 'Title')] or .//td[contains(normalize-space(.), 'Title')] ]"
        )
      );
    } catch (e) {
      return false;
    }

    const candidates = await row.findElements(
      By.css(
        "[data-fieldname='title'] input, input[name='title'], input[type='text'], input:not([type])"
      )
    );
    if (!candidates.length) return false;

    let input = null;
    for (const el of candidates) {
      try {
        const ro = (await el.getAttribute('readonly')) || '';
        const dis = (await el.getAttribute('disabled')) || '';
        if (ro || dis) continue;
        const typeAttr = (await el.getAttribute('type')) || 'text';
        if (typeAttr === 'hidden') continue;
        const display = (await el.getCssValue('display')) || '';
        const visibility = (await el.getCssValue('visibility')) || '';
        const opacity = parseFloat(((await el.getCssValue('opacity')) || '1'));
        const rect = await el.getRect();
        if (display === 'none' || visibility === 'hidden' || opacity === 0 || rect.height < 2 || rect.width < 2) {
          continue;
        }
        input = el;
        break;
      } catch (e) {}
    }
    if (!input) return false;

    await this.scrollIntoView(input);
    await input.click();
    await this.driver.sleep(100);
    await input.clear().catch(() => {});
    await input.sendKeys(value);
    await this.driver.sleep(200);
    return true;
  }

  async clickAssignButton() {
    const xpathCandidates = [
      `//div[contains(@class,"o_form_statusbar")]//button[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"ASSIGN")]`,
      `//header//button[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"ASSIGN")]`,
    ];
    let btn = null;
    for (const xp of xpathCandidates) {
      const found = await this.driver.findElements(By.xpath(xp));
      if (found.length) {
        btn = found[0];
        break;
      }
    }
    if (!btn) {
      const clicked = await this.clickActionMenuItem([
        "Assign",
        "Assignment",
        "Tugaskan",
        "Penugasan",
      ]);
      if (clicked) {
        await this.driver.sleep(800);
        return true;
      }
      return false;
    }
    try {
      await btn.click();
    } catch (e) {
      return false;
    }
    await this.driver.sleep(600);
    return true;
  }

  async clickStartButtonRobust() {
    const labels = ["Start", "Mulai", "Start Ticket", "Start Task"];
    let btn = null;

    // 1) Prefer Start button inside the currently open modal (e.g. "Open: Request")
    try {
      const modal = await this.getLatestModal();
      for (const lab of labels) {
        const xp = `.//*[self::button or self::a][contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"${lab.toUpperCase()}")]`;
        const found = await modal.findElements(By.xpath(xp));
        if (found.length) {
          btn = found[0];
          break;
        }
      }
    } catch (e) {}

    // 2) Fallback: global statusbar/header search
    if (!btn) {
      const xpathCandidates = [
        `//div[contains(@class,"o_form_statusbar")]//button[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"START")]`,
        `//header//button[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"START")]`,
      ];
      for (const xp of xpathCandidates) {
        const found = await this.driver.findElements(By.xpath(xp));
        if (found.length) {
          btn = found[0];
          break;
        }
      }
    }

    // 3) Fallback: action menu item
    if (!btn) {
      const clicked = await this.clickActionMenuItem(labels);
      if (clicked) {
        await this.driver.sleep(1200);
        return true;
      }
      return false;
    }

    try {
      await this.scrollIntoView(btn);
    } catch (e) {}
    try {
      await btn.click();
    } catch (e) {
      return false;
    }
    await this.driver.sleep(1200);
    return true;
  }

  async clickFormButton({
    labels = [],
    names = [],
    allowDropdown = false,
    waitMs = 800,
  } = {}) {
    const xpathCandidates = [];
    for (const name of names) {
      xpathCandidates.push(
        `//div[contains(@class,'o_form_statusbar')]//button[@name='${name}']`
      );
      xpathCandidates.push(`//header//button[@name='${name}']`);
      xpathCandidates.push(
        `//div[contains(@class,'o_form_buttons_view')]//button[@name='${name}']`
      );
      xpathCandidates.push(
        `//div[contains(@class,'o_form_buttons_edit')]//button[@name='${name}']`
      );
      xpathCandidates.push(
        `//div[contains(@class,'o_control_panel')]//button[@name='${name}']`
      );
    }

    for (const label of labels) {
      const upper = (label || "").toUpperCase();
      const labelXPath = `contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"${upper}")`;
      xpathCandidates.push(
        `//div[contains(@class,'o_form_statusbar')]//button[${labelXPath}]`
      );
      xpathCandidates.push(`//header//button[${labelXPath}]`);
      xpathCandidates.push(
        `//div[contains(@class,'o_form_buttons_view')]//button[${labelXPath}]`
      );
      xpathCandidates.push(
        `//div[contains(@class,'o_form_buttons_edit')]//button[${labelXPath}]`
      );
      xpathCandidates.push(
        `//div[contains(@class,'o_control_panel')]//button[${labelXPath}]`
      );
    }

    for (const xp of xpathCandidates) {
      const found = await this.driver.findElements(By.xpath(xp));
      if (found.length) {
        const btn = found[0];
        try {
          await this.scrollIntoView(btn);
        } catch (e) {}
        try {
          await btn.click();
          await this.driver.sleep(waitMs);
          return true;
        } catch (e) {
          try {
            await this.driver.executeScript("arguments[0].click();", btn);
            await this.driver.sleep(waitMs);
            return true;
          } catch (err) {}
        }
      }
    }

    if (allowDropdown && labels.length) {
      const clicked = await this.clickActionMenuItem(labels);
      if (clicked) {
        await this.driver.sleep(waitMs);
        return true;
      }
    }

    return false;
  }

  async clickEditButton() {
    return await this.clickFormButton({
      labels: ["Edit", "Ubah"],
      names: ["edit"],
      allowDropdown: true,
      waitMs: 600,
    });
  }

  async clickSaveButton() {
    return await this.clickFormButton({
      labels: ["Save", "Simpan"],
      names: ["save_button"],
      allowDropdown: true,
      waitMs: 900,
    });
  }

  async clickDoneButton() {
    return await this.clickFormButton({
      labels: ["Done", "Selesai"],
      names: ["action_done", "done"],
      allowDropdown: true,
      waitMs: 1200,
    });
  }

  async clickSetDueDateButton() {
    return await this.clickFormButton({
      labels: ["Set Due Date", "Due Date"],
      names: ["set_due_date"],
      allowDropdown: true,
      waitMs: 600,
    });
  }

  async openOutstandingTaskList() {
    if (!this.driver) {
      throw new Error("WebDriver belum siap");
    }
    const outstandingUrl = `${config.koprol.url}/web#action=428&model=eps.request.form.line&view_type=list&menu_id=301`;
    const listSelectors = [
      "table.o_list_table",
      ".o_list_view table.o_list_table",
      ".o_list_renderer table",
      ".o_list_table.o_list_view",
    ];
    const blockingSelectors = [
      ".o_loading",
      ".o_loading_indicator",
      ".o_planner_loading",
      ".o_blockUI",
      ".o_dialog_container .o_spinner",
    ];
    
    // Helper: buka Outstanding lewat menu Request Form (tanpa direct URL)
    const openViaMenu = async () => {
      try {
        logger.info("Opening Outstanding Task list via Request Form app menu");

        // 1) Buka aplikasi Request Form dari app switcher/menu
        await this.openRequestFormApp();
        try {
          await this.waitForUrlContains("model=eps.request.form", 12000);
        } catch (e) {}
        await this.waitForPageReady();

        // 2) Cari dan klik menu/tab "Outstanding Task" di navbar atas
        const menuXPaths = [
          "//div[contains(@class,'o_main_navbar')]//a[normalize-space(.)='Outstanding Task']",
          "//div[contains(@class,'o_main_navbar')]//a[contains(normalize-space(.),'Outstanding Task')]",
          "//nav//a[normalize-space(.)='Outstanding Task']",
          "//nav//a[contains(normalize-space(.),'Outstanding Task')]",
        ];
        let clicked = false;
        for (const xp of menuXPaths) {
          const items = await this.driver.findElements(By.xpath(xp));
          if (items.length) {
            try {
              await this.scrollIntoView(items[0]).catch(() => {});
              await items[0].click();
              clicked = true;
              break;
            } catch (e) {}
          }
        }

        if (!clicked) {
          throw new Error("Menu Outstanding Task tidak ditemukan di navbar");
        }

        // 3) Tunggu sampai berpindah ke model eps.request.form.line (Outstanding Task list)
        try {
          await this.waitForUrlContains("model=eps.request.form.line", 12000);
        } catch (e) {}
        await this.waitForPageReady();
        await this.waitUntilSelectorsGone(blockingSelectors, 12000);

        const listElement = await this.waitForAnyCss(listSelectors, 12000);
        if (listElement) {
          try {
            await this.scrollIntoView(listElement);
          } catch (e) {}
        }
        await this.driver.sleep(400);
        return true;
      } catch (e) {
        logger.warn("Outstanding Task navigation via menu failed", {
          message: e.message,
        });
        return false;
      }
    };

    // Helper: fallback lama menggunakan direct URL (dipakai jika menu gagal)
    const openViaDirectUrl = async () => {
      logger.info(
        `Opening Outstanding Task list via direct URL: ${outstandingUrl}`
      );
      await this.driver.get(outstandingUrl);

      try {
        await this.waitForPageReady();
        await this.waitUntilSelectorsGone(blockingSelectors, 12000);

        const modals = await this.driver.findElements(By.css(".modal-content"));
        if (modals.length) {
          for (const modal of modals) {
            try {
              const buttons = await modal.findElements(
                By.css("button.btn-primary, button.btn-secondary, button.btn")
              );
              if (buttons.length) {
                await buttons[0].click();
                await this.driver.sleep(200);
              }
            } catch (e) {}
          }
          await this.waitUntilSelectorsGone(
            [".modal-content", ".o_dialog_container"],
            5000
          );
        }

        const listElement = await this.waitForAnyCss(listSelectors, 12000);
        if (listElement) {
          try {
            await this.scrollIntoView(listElement);
          } catch (e) {}
        }
        await this.driver.sleep(400);
        return true;
      } catch (e) {
        logger.warn("Outstanding Task list failed to load via direct URL", {
          message: e.message,
        });
        return false;
      }
    };

    // 1) Coba lewat menu Request Form -> Outstanding Task terlebih dahulu
    const viaMenuOk = await openViaMenu();
    if (viaMenuOk) {
      return true;
    }

    // 2) Jika gagal, fallback satu kali ke direct URL (beserta snapshot + screenshot bila tetap gagal)
    const viaDirectOk = await openViaDirectUrl();
    if (viaDirectOk) {
      return true;
    }

    // 3) Diagnosa terakhir + screenshot, lalu error seperti sebelumnya
    try {
      await this.driver.sleep(2000);

      let url = "";
      try {
        url = await this.driver.getCurrentUrl();
      } catch (err) {}

      let title = "";
      let bodySnippet = "";
      try {
        const info = await this.driver.executeScript(
          "return { title: document.title || '', body: (document.body && document.body.innerText) || '' };"
        );
        title = info && info.title ? info.title : "";
        if (info && info.body) {
          bodySnippet = info.body.substring(0, 500);
        }
      } catch (err) {}

      logger.warn("Outstanding list failure page snapshot", {
        url,
        title,
        bodySnippet,
      });

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = path.join(__dirname, "..", "..", "screenshots");
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {}
      const filePath = path.join(dir, `outstanding_list_error_${ts}.png`);
      const image = await this.driver.takeScreenshot();
      fs.writeFileSync(filePath, image, "base64");
      logger.warn("Saved screenshot for Outstanding list failure", {
        filePath,
      });
    } catch (err) {}

    throw new Error("Outstanding Task list tidak bisa dibuka");
  }

  async scrapeOutstandingTasks(picName, maxRows = 10) {
    const table = await this.driver.findElement(By.css("table.o_list_table"));
    const headerEls = await table.findElements(By.css("thead tr th"));
    const headers = [];
    for (const headerEl of headerEls) {
      let headerText = "";
      try {
        headerText = (await headerEl.getText()).trim();
      } catch (e) {}
      headers.push(headerText || `col_${headers.length}`);
    }

    const rows = await table.findElements(By.css("tbody tr"));
    const tasks = [];
    const normalizedPic = (picName || "").trim().toLowerCase();

    for (const row of rows) {
      const cells = await row.findElements(By.css("td"));
      if (!cells.length) continue;

      const rowData = {};
      for (let i = 0; i < cells.length && i < headers.length; i++) {
        let text = "";
        try {
          text = (await cells[i].getText()).trim();
        } catch (e) {}
        rowData[headers[i]] = text;
      }

      const picValue =
        rowData["PIC"] ||
        rowData["Pic"] ||
        rowData["pic"] ||
        rowData["Assigned to"] ||
        "";
      if (
        normalizedPic &&
        (!picValue || !picValue.toLowerCase().includes(normalizedPic))
      ) {
        continue;
      }

      tasks.push({
        ticket:
          rowData["Name"] ||
          rowData["Nomor"] ||
          rowData["Request Form"] ||
          rowData[headers[0]] ||
          "",
        request: rowData["Request"] || "",
        user: rowData["User Request"] || rowData["Requester"] || "",
        assignDate: rowData["Assign Date"] || rowData["Date"] || "",
        // Ambil Due Date dari kolom list jika tersedia, supaya bisa diinformasikan ke WA.
        dueDate:
          rowData["Due Date"] ||
          rowData["Due date"] ||
          rowData["Due"] ||
          "",
        state: rowData["State"] || "",
        clock: rowData["Clocking State"] || rowData["Clock"] || "",
        pic: (picValue || "").trim(),
      });

      if (tasks.length >= maxRows) break;
    }

    return tasks;
  }

  async fetchOutstandingTasks(picName, maxRows = 10) {
    await this.initialize();
    await this.login();
    await this.openOutstandingTaskList();
    return await this.scrapeOutstandingTasks(picName, maxRows);
  }

  // Baca informasi tanggal (Assign On, Due Date) langsung dari form tiket.
  // Dipakai WhatsApp bot untuk memberi tahu user sebelum mengisi offset Days.
  async getTicketDueDate(ticketIdentifier) {
    if (!ticketIdentifier) {
      throw new Error("Nomor tiket untuk membaca Due Date tidak diberikan");
    }

    await this.initialize();
    await this.login();
    await this.openOutstandingTaskList();

    const row = await this.findOutstandingRow(ticketIdentifier);
    if (!row) {
      throw new Error(
        `Tidak menemukan tiket ${ticketIdentifier} di Outstanding Task`
      );
    }

    try {
      await this.scrollIntoView(row);
    } catch (e) {}

    let rowOpened = false;
    try {
      await this.driver
        .actions({ bridge: true })
        .move({ origin: row })
        .doubleClick()
        .perform();
      rowOpened = true;
    } catch (e) {}

    if (!rowOpened) {
      try {
        await row.click();
        await this.driver.sleep(150);
        await this.driver
          .actions({ bridge: true })
          .move({ origin: row })
          .doubleClick()
          .perform();
        rowOpened = true;
      } catch (e) {}
    }

    if (!rowOpened) {
      try {
        await row.click();
        await this.driver.sleep(150);
        await this.driver
          .actions({ bridge: true })
          .sendKeys(Key.RETURN)
          .perform();
        rowOpened = true;
      } catch (e) {}
    }

    if (!rowOpened) {
      throw new Error(
        "Gagal membuka form tiket dari daftar Outstanding untuk membaca Due Date"
      );
    }

    await this.waitForFormView();

    // Pastikan bagian bawah form (yang berisi Due Date) terlihat
    try {
      await this.driver.executeScript(
        "try { window.scrollTo(0, document.body.scrollHeight); } catch(e) {}"
      );
      await this.driver.sleep(300);
    } catch (e) {}

    const assignOn = await this.getFieldValueByLabel("Assign On");

    // Pertama coba cara umum via getFieldValueByLabel
    let dueDate = await this.getFieldValueByLabel("Due Date");

    // Jika masih kosong, gunakan fallback yang lebih spesifik.
    if (!dueDate) {
      // 1) Langsung cari field span dengan name="due_date" seperti di screenshot DevTools.
      try {
        const dateSpans = await this.driver.findElements(
          By.css("span.o_field_date.o_field_widget[name='due_date']")
        );
        if (dateSpans.length) {
          let rawText = (await dateSpans[0].getText()).trim();
          if (!rawText) {
            try {
              rawText = (
                (await dateSpans[0].getAttribute("textContent")) || ""
              ).trim();
            } catch (e) {}
          }
          logger.info("Raw Due Date text from span[name=due_date]", {
            ticketIdentifier,
            rawText,
          });
          if (rawText) {
            dueDate = rawText;
          }
        }
      } catch (e) {
        logger.warn(
          "CSS lookup for span[name=due_date] failed",
          e && e.message ? e.message : e
        );
      }

      // 2) Jika masih belum ketemu, coba XPath berbasis label/td sebagai cadangan.
      if (!dueDate) {
        try {
          const candidates = await this.driver.findElements(
            By.xpath(
              "//td[normalize-space(.)='Due Date']/following-sibling::td[1]//*[self::span or self::div or self::td]" +
                " | //label[normalize-space(.)='Due Date']/ancestor::td/following-sibling::td[1]//*[self::span or self::div or self::td]"
            )
          );
          if (candidates.length) {
            let rawText = (await candidates[0].getText()).trim();
            if (!rawText) {
              try {
                rawText = (
                  (await candidates[0].getAttribute("textContent")) || ""
                ).trim();
              } catch (e) {}
            }
            logger.info("Raw Due Date text from label-based XPath", {
              ticketIdentifier,
              rawText,
            });
            if (rawText) {
              dueDate = rawText;
            }
          }
        } catch (e) {
          logger.warn(
            "Fallback XPath Due Date lookup failed",
            e && e.message ? e.message : e
          );
        }
      }
    }

    logger.info("Info tanggal tiket sebelum pengisian Done", {
      ticketIdentifier,
      assignOn,
      dueDate,
    });

    return { assignOn, dueDate };
  }

  async findOutstandingRow(ticketIdentifier) {
    const safeTicket = this.xpathLiteral(ticketIdentifier.trim());
    const rowXpath = `//table[contains(@class,'o_list_table')]//tr[contains(@class,'o_data_row')][.//span[contains(normalize-space(.), ${safeTicket})] or .//td[contains(normalize-space(.), ${safeTicket})]]`;
    const rows = await this.driver.findElements(By.xpath(rowXpath));
    if (rows.length) {
      return rows[0];
    }
    return null;
  }

  async breakOutstandingTicket(ticketIdentifier, reasonText) {
    if (!ticketIdentifier) {
      throw new Error("Nomor tiket untuk Break tidak diberikan");
    }
    const reason = (reasonText || "").trim();
    if (!reason) {
      throw new Error("Alasan Break tidak boleh kosong");
    }

    await this.initialize();
    await this.login();
    await this.openOutstandingTaskList();

    const row = await this.findOutstandingRow(ticketIdentifier);
    if (!row) {
      throw new Error(`Tidak menemukan tiket ${ticketIdentifier} di Outstanding Task`);
    }

    let breakBtn = null;
    const breakButtons = await row.findElements(
      By.xpath(".//button[contains(normalize-space(.), 'Break')]")
    );
    for (const btn of breakButtons) {
      const label = (await btn.getText()).trim().toLowerCase();
      if (label === "break") {
        breakBtn = btn;
        break;
      }
    }
    if (!breakBtn && breakButtons.length) {
      breakBtn = breakButtons[0];
    }
    if (!breakBtn) {
      throw new Error("Tombol Break tidak ditemukan pada baris tiket ini");
    }

    try {
      await this.scrollIntoView(breakBtn);
    } catch (e) {}

    await breakBtn.click();
    await this.driver
      .wait(until.elementLocated(By.css(".modal-content")), 5000)
      .catch(() => {});
    await this.driver.sleep(300);

    const modal = await this.getLatestModal();

    let reasonInput = null;
    const reasonSelectors = [
      "textarea[name*='reason']",
      "textarea[name*='break']",
      "input[name*='reason']",
      "input[name*='break']",
    ];
    for (const sel of reasonSelectors) {
      const inputs = await modal.findElements(By.css(sel));
      if (inputs.length) {
        reasonInput = inputs[0];
        break;
      }
    }
    if (!reasonInput) {
      const textareas = await modal.findElements(By.css("textarea"));
      if (textareas.length) {
        reasonInput = textareas[0];
      }
    }
    if (!reasonInput) {
      const inputs = await modal.findElements(
        By.css("input[type='text'], input:not([type])")
      );
      if (inputs.length) {
        reasonInput = inputs[0];
      }
    }
    if (!reasonInput) {
      throw new Error("Kolom Alasan Break tidak ditemukan");
    }

    await this.scrollIntoView(reasonInput).catch(() => {});
    await reasonInput.click();
    try {
      await reasonInput.clear();
    } catch (e) {}
    try {
      await reasonInput.sendKeys(Key.chord(Key.CONTROL, "a"));
      await reasonInput.sendKeys(Key.BACK_SPACE);
    } catch (e) {}
    await reasonInput.sendKeys(reason);

    await this.clickButtonInModal(modal, "Break");
    try {
      await this.driver.wait(until.stalenessOf(modal), 5000);
    } catch (e) {}
    await this.driver.sleep(500);

    return true;
  }

  async endBreakOutstandingTicket(ticketIdentifier) {
    if (!ticketIdentifier) {
      throw new Error("Nomor tiket untuk End Break tidak diberikan");
    }

    await this.initialize();
    await this.login();
    await this.openOutstandingTaskList();

    const row = await this.findOutstandingRow(ticketIdentifier);
    if (!row) {
      throw new Error(`Tidak menemukan tiket ${ticketIdentifier} di Outstanding Task`);
    }

    let endBreakBtn = null;
    const btnCandidates = await row.findElements(
      By.xpath(
        ".//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'end break')]"
      )
    );
    for (const btn of btnCandidates) {
      const label = (await btn.getText()).trim().toLowerCase();
      if (label.includes("end break")) {
        endBreakBtn = btn;
        break;
      }
    }
    if (!endBreakBtn && btnCandidates.length) {
      endBreakBtn = btnCandidates[0];
    }
    if (!endBreakBtn) {
      throw new Error("Tombol End Break tidak ditemukan pada baris tiket ini");
    }

    try {
      await this.scrollIntoView(endBreakBtn);
    } catch (e) {}

    await endBreakBtn.click();

    let modal = null;
    try {
      await this.driver
        .wait(until.elementLocated(By.css(".modal-content")), 2500)
        .catch(() => {});
      modal = await this.getLatestModal();
    } catch (e) {
      modal = null;
    }

    if (modal) {
      const confirmLabels = ["End Break", "END BREAK", "Confirm", "Ya", "OK"];
      let clicked = false;
      for (const label of confirmLabels) {
        try {
          await this.clickButtonInModal(modal, label);
          clicked = true;
          break;
        } catch (e) {}
      }
      if (!clicked) {
        // If no labeled button found, try default primary button
        try {
          const primaryBtn = await modal.findElement(
            By.css("button.btn-primary, button.btn-danger, button.btn-info")
          );
          await primaryBtn.click();
        } catch (e) {}
      }
      try {
        await this.driver.wait(until.stalenessOf(modal), 5000);
      } catch (e) {}
    }

    await this.driver.sleep(500);
    return true;
  }

  async completeOutstandingTicket(ticketIdentifier, closing = {}) {
    if (!ticketIdentifier) {
      throw new Error("Nomor tiket untuk Done tidak diberikan");
    }

    const closingData = {
      impact: closing.impact || "",
      urgency: closing.urgency || "",
      rca: (closing.rca || "").trim(),
      solution: (closing.solution || "").trim(),
      // Nilai manual dari WhatsApp untuk offset Days (string), jika ada.
      dueDays: typeof closing.dueDays === "string" ? closing.dueDays : null,
      dueDate: closing.dueDate || null,
      dueInDays: closing.dueInDays || 1,
    };

    if (!closingData.rca) {
      throw new Error("RCA wajib diisi sebelum menutup tiket");
    }
    if (!closingData.solution) {
      throw new Error("Solusi wajib diisi sebelum menutup tiket");
    }

    await this.initialize();
    await this.login();
    await this.openOutstandingTaskList();

    const row = await this.findOutstandingRow(ticketIdentifier);
    if (!row) {
      throw new Error(
        `Tidak menemukan tiket ${ticketIdentifier} di Outstanding Task`
      );
    }

    try {
      await this.scrollIntoView(row);
    } catch (e) {}

    let rowOpened = false;
    try {
      await this.driver
        .actions({ bridge: true })
        .move({ origin: row })
        .doubleClick()
        .perform();
      rowOpened = true;
    } catch (e) {}

    if (!rowOpened) {
      try {
        await row.click();
        await this.driver.sleep(150);
        await this.driver
          .actions({ bridge: true })
          .move({ origin: row })
          .doubleClick()
          .perform();
        rowOpened = true;
      } catch (e) {}
    }

    if (!rowOpened) {
      try {
        await row.click();
        await this.driver.sleep(150);
        await this.driver
          .actions({ bridge: true })
          .sendKeys(Key.RETURN)
          .perform();
        rowOpened = true;
      } catch (e) {}
    }

    if (!rowOpened) {
      throw new Error(
        "Gagal membuka form tiket dari daftar Outstanding (double click gagal)"
      );
    }

    await this.waitForFormView();

    const editClicked = await this.clickEditButton();
    if (!editClicked) {
      throw new Error("Tombol Edit tidak ditemukan pada form tiket");
    }

    await this.driver.sleep(400);

    let formRoot = null;
    try {
      formRoot = await this.driver.findElement(
        By.css(".o_form_view, .o_form_renderer, .o_form_sheet")
      );
    } catch (e) {
      formRoot = await this.driver.findElement(By.css("body"));
    }

    if (closingData.impact) {
      let impactFilled = false;

      // 1) Coba dropdown berdasarkan label yang umum dipakai
      try {
        impactFilled = await this.safeSelectDropdownInModal(
          formRoot,
          ["Impact", "Dampak"],
          closingData.impact
        );
      } catch (e) {}

      // 2) Fallback: field berbasis atribut teknis (mis. data-fieldname/name="impact")
      if (!impactFilled) {
        try {
          impactFilled = await this.fillTextFieldByFieldNameAttr(
            formRoot,
            ["impact"],
            closingData.impact
          );
        } catch (e) {}
      }

      if (!impactFilled) {
        logger.warn(
          "Field Impact tidak ditemukan, melewati pengisian impact",
        );
      }
    }

    if (closingData.urgency) {
      let urgencyFilled = false;
      // Try dedicated dropdown helper (click + enter)
      try {
        urgencyFilled = await this.selectUrgencyDropdown(
          formRoot,
          closingData.urgency
        );
      } catch (e) {}

      // Fallback: generic dropdown selector
      if (!urgencyFilled) {
        try {
          urgencyFilled = await this.safeSelectDropdownInModal(
            formRoot,
            ["Urgency", "Urgensi"],
            closingData.urgency
          );
        } catch (e) {}
      }

      // Fallback: direct input field by data-fieldname
      if (!urgencyFilled) {
        try {
          urgencyFilled = await this.fillTextFieldByFieldNameAttr(
            formRoot,
            ["urgency"],
            closingData.urgency
          );
        } catch (e) {}
      }

      if (!urgencyFilled) {
        logger.warn("Field Urgency tidak ditemukan, melewati pengisian urgency");
      }
    }

    // RCA: utamakan input dengan name="rca" (Problem Detail), lalu fieldname/label.
    let rcaFilled = false;
    for (let attempt = 0; attempt < 3 && !rcaFilled; attempt++) {
      await this.dismissAnyModal(2500);
      try {
        const rcaInputs = await formRoot.findElements(
          By.css("input[name='rca'], textarea[name='rca']")
        );
        if (rcaInputs.length) {
          const rcaInput = rcaInputs[0];
          await this.scrollIntoView(rcaInput).catch(() => {});
          try {
            await rcaInput.click();
          } catch (e) {}
          try {
            await rcaInput.clear();
          } catch (e) {}
          await rcaInput.sendKeys(closingData.rca);
          rcaFilled = true;
          break;
        }
      } catch (e) {}

      if (!rcaFilled) {
        try {
          rcaFilled = await this.fillTextFieldByFieldNameAttr(
            formRoot,
            ["rca", "root_cause", "root_cause_analysis"],
            closingData.rca
          );
        } catch (e) {}
      }

      if (!rcaFilled) {
        rcaFilled = await this.safeFillTextFieldInModal(
          formRoot,
          ["RCA", "Root Cause", "Root Cause Analysis"],
          closingData.rca
        );
      }
    }
    if (!rcaFilled) {
      throw new Error("Field RCA tidak ditemukan atau tidak dapat diisi");
    }

    // Solution: utamakan input dengan name="solution", lalu fieldname/label.
    let solutionFilled = false;
    for (let attempt = 0; attempt < 3 && !solutionFilled; attempt++) {
      await this.dismissAnyModal(2500);
      try {
        const solInputs = await formRoot.findElements(
          By.css("input[name='solution'], textarea[name='solution']")
        );
        if (solInputs.length) {
          const solInput = solInputs[0];
          await this.scrollIntoView(solInput).catch(() => {});
          try {
            await solInput.click();
          } catch (e) {}
          try {
            await solInput.clear();
          } catch (e) {}
          await solInput.sendKeys(closingData.solution);
          solutionFilled = true;
          break;
        }
      } catch (e) {}

      if (!solutionFilled) {
        try {
          solutionFilled = await this.fillTextFieldByFieldNameAttr(
            formRoot,
            ["solution", "solusi", "action_taken", "fix"],
            closingData.solution
          );
        } catch (e) {}
      }

      if (!solutionFilled) {
        solutionFilled = await this.safeFillTextFieldInModal(
          formRoot,
          ["Solution", "Solusi", "Action Taken", "Fix"],
          closingData.solution
        );
      }
    }
    if (!solutionFilled) {
      throw new Error("Field Solusi tidak ditemukan atau tidak dapat diisi");
    }

    const savedBeforeDue = await this.clickSaveButton();
    if (!savedBeforeDue) {
      throw new Error("Gagal menyimpan perubahan tiket sebelum Set Due Date");
    }

    await this.driver.sleep(500);

    // Baca Due Date sebelum diubah untuk menentukan apakah perlu diubah dan untuk verifikasi.
    const beforeDueDateText = await this.getFieldValueByLabel("Due Date");

    // Parse format seperti "21-12-2025 10:26:58" (DD-MM-YYYY HH:mm:ss) jika memungkinkan.
    let beforeDueDateObj = null;
    if (beforeDueDateText) {
      try {
        const m = beforeDueDateText.match(
          /(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/
        );
        if (m) {
          const day = parseInt(m[1], 10);
          const month = parseInt(m[2], 10) - 1;
          const year = parseInt(m[3], 10);
          const hh = parseInt(m[4], 10);
          const mm = parseInt(m[5], 10);
          const ss = parseInt(m[6], 10);
          const d = new Date(year, month, day, hh, mm, ss);
          if (!isNaN(d.getTime())) {
            beforeDueDateObj = d;
          }
        }
      } catch (e) {}
    }

    const now = new Date();
    const nowTs = now.getTime();
    const isAlreadyFuture =
      beforeDueDateObj && beforeDueDateObj.getTime() > nowTs;

    // Ambil preferensi manual dari WhatsApp (answers.dueDays) bila ada.
    let manualOffsetDays = null;
    let manualOffsetRaw = null;
    if (closingData && typeof closingData.dueDays === "string") {
      const raw = closingData.dueDays.trim();
      if (raw) {
        manualOffsetRaw = raw;
        const normalized = raw.replace(",", ".");
        const num = parseFloat(normalized);
        if (!isNaN(num) && num > 0) {
          manualOffsetDays = num;
        }
      }
    }

    logger.info("Due Date sebelum Set Due Date", {
      raw: beforeDueDateText,
      parsedIso: beforeDueDateObj ? beforeDueDateObj.toISOString() : null,
      nowIso: now.toISOString(),
      isAlreadyFuture,
      manualOffsetRaw,
    });

    if (!isAlreadyFuture) {
      // Hanya ubah Due Date jika saat ini belum di masa depan.
      if (typeof this.setFutureDueDate === "function") {
        // Jika user sudah memberikan offset Days manual via WhatsApp (dueDays > 0),
        // gunakan nilai tersebut. Jika tidak, gunakan perhitungan otomatis H+1.
        let offsetDaysSource = "auto";
        let offsetDays = 2; // fallback aman jika parsing gagal
        let overdueDays = 0;
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;

        if (manualOffsetDays !== null) {
          offsetDays = manualOffsetDays;
          offsetDaysSource = "manual";
        } else if (beforeDueDateObj) {
          const diffFromNowMs = nowTs - beforeDueDateObj.getTime();
          overdueDays =
            diffFromNowMs > 0
              ? Math.ceil(diffFromNowMs / ONE_DAY_MS)
              : 0;
          offsetDays = Math.max(1, overdueDays + 1);
        }

        logger.info("Perhitungan offset Set Due Date", {
          raw: beforeDueDateText,
          parsedIso: beforeDueDateObj
            ? beforeDueDateObj.toISOString()
            : null,
          nowIso: now.toISOString(),
          overdueDays,
          offsetDays,
          offsetDaysSource,
          manualOffsetRaw,
        });

        try {
          await this.setFutureDueDate({
            minOffsetDays: offsetDays,
          });
        } catch (e) {
          throw new Error(
            `Gagal membuka atau menyimpan dialog Set Due Date: ${
              e.message || e
            }`
          );
        }
      } else {
        throw new Error(
          "Fitur Set Due Date belum diimplementasikan, tiket tidak akan di-Done"
        );
      }

      // Beri waktu UI untuk meng-update field setelah wizard Set Due Date
      await this.driver.sleep(700);
      const afterDueDateText = await this.getFieldValueByLabel("Due Date");

      if (!afterDueDateText || afterDueDateText === beforeDueDateText) {
        throw new Error(
          "Set Due Date tidak berhasil mengubah kolom Due Date. Mohon cek manual di Koprol."
        );
      }
    } else {
      logger.info(
        "Melewati perubahan Due Date karena sudah di masa depan",
        {
          beforeDueDateText,
        }
      );
    }

    const savedAfterDue = await this.clickSaveButton();
    if (!savedAfterDue) {
      throw new Error("Gagal menyimpan tiket setelah Set Due Date");
    }

    const doneClicked = await this.clickDoneButton();
    if (!doneClicked) {
      throw new Error("Tombol Done tidak ditemukan");
    }

    await this.driver.sleep(1000);

    // Setelah tiket berhasil di-Done di backend, siapkan data untuk halaman rating publik
    let requestFormNumber = "";
    try {
      requestFormNumber =
        (await this.getFieldValueByLabel("Request Form")) || "";
    } catch (e) {}

    let customerPhone = "";
    try {
      customerPhone =
        (await this.getFieldValueByLabel("Nomor Telp")) || "";
      if (!customerPhone) {
        customerPhone =
          (await this.getFieldValueByLabel("No. HP")) || "";
      }
    } catch (e) {}

    // Bangun URL status_request publik untuk rating
    const baseUrl =
      (config.koprol && config.koprol.url) ||
      "https://koprol.tunasgroup.com";
    const publicBase = baseUrl
      .replace(/\/web\/?$/, "")
      .replace(/\/$/, "");

    const statusUrl = requestFormNumber
      ? `${publicBase}/status_request?search=${encodeURIComponent(
          requestFormNumber
        )}`
      : "";

    return {
      success: true,
      ticketIdentifier,
      requestFormNumber,
      statusUrl,
      customerPhone,
    };
  }

  async setFutureDueDate({ minOffsetDays = 1 } = {}) {
    // Buka dialog Set Due Date, isi offset Due Date > 0 (Days), pilih tipe Days, lalu klik Save.
    await this.dismissAnyModal(2000);

    const clicked = await this.clickSetDueDateButton();
    if (!clicked) {
      throw new Error("Tombol Set Due Date tidak ditemukan");
    }

    try {
      await this.driver
        .wait(until.elementLocated(By.css(".modal-content")), 5000)
        .catch(() => {});
    } catch (e) {}

    let modal;
    try {
      modal = await this.getLatestModal();
    } catch (e) {
      throw new Error("Dialog Set Due Date tidak muncul");
    }

    // Cari input offset (Due Date numeric) dan set minimal minOffsetDays
    try {
      const offsetInput = await modal.findElement(
        By.css("input[name='due_date_input']")
      );
      await this.scrollIntoView(offsetInput).catch(() => {});
      try {
        await offsetInput.click();
      } catch (e) {}
      try {
        await offsetInput.clear();
      } catch (e) {}
      await offsetInput.sendKeys(String(minOffsetDays));
      await this.driver.sleep(200);
    } catch (e) {
      // Biarkan lanjut, tapi kemungkinan Due Date tidak akan berubah
    }

    // Pastikan unit offset adalah Days (bukan Hour/Minutes)
    try {
      let unitSelect = null;
      // Coba seleksi langsung berdasarkan name
      try {
        unitSelect = await modal.findElement(
          By.css("select[name='due_date_type']")
        );
      } catch (e1) {}

      // Fallback: gunakan select pertama yang terlihat di dalam modal
      if (!unitSelect) {
        const allSelects = await modal.findElements(By.css("select"));
        for (const sel of allSelects) {
          try {
            const display = (await sel.getCssValue("display")) || "";
            const visibility = (await sel.getCssValue("visibility")) || "";
            const opacity = parseFloat(
              (await sel.getCssValue("opacity")) || "1"
            );
            const rect = await sel.getRect();
            if (
              display === "none" ||
              visibility === "hidden" ||
              opacity === 0 ||
              rect.height < 2 ||
              rect.width < 2
            ) {
              continue;
            }
            unitSelect = sel;
            break;
          } catch (e2) {}
        }
      }

      if (!unitSelect) {
        throw new Error(
          "Field Due Date Type tidak ditemukan di dialog Set Due Date"
        );
      }

      await this.scrollIntoView(unitSelect).catch(() => {});
      try {
        await unitSelect.click();
        await this.driver.sleep(200);
      } catch (e) {}

      // Pilih option yang teksnya mengandung 'Day' atau 'Hari'
      let picked = false;
      const options = await unitSelect.findElements(By.css("option"));
      for (const opt of options) {
        let txt = "";
        try {
          txt = (await opt.getText()) || "";
        } catch (e2) {}
        const lower = txt.toLowerCase();
        if (lower.includes("day") || lower.includes("hari")) {
          try {
            await opt.click();
            picked = true;
            break;
          } catch (e3) {}
        }
      }

      if (!picked) {
        throw new Error(
          "Opsi 'Days' untuk Due Date Type tidak ditemukan di dialog Set Due Date"
        );
      }

      await this.driver.sleep(200);
    } catch (e) {
      // Jika gagal menemukan atau meng-set Due Date Type, lebih baik gagal eksplisit
      throw e;
    }

    // Klik tombol Save / Simpan di dialog Set Due Date
    let saved = false;
    for (const label of ["Save", "Simpan"]) {
      if (saved) break;
      try {
        await this.clickButtonInModal(modal, label);
        saved = true;
        break;
      } catch (e) {}
    }

    if (!saved) {
      throw new Error("Tombol Save pada dialog Set Due Date tidak ditemukan");
    }

    try {
      await this.driver.wait(until.stalenessOf(modal), 5000);
    } catch (e) {}
    await this.driver.sleep(400);
  }

  async openPublicTicketForm() {
    if (!this.driver) {
      await this.initialize();
    }

    const baseUrl =
      (config.koprol && config.koprol.url) ||
      "https://koprol.tunasgroup.com";
    const publicBase = baseUrl
      .replace(/\/web\/?$/, "")
      .replace(/\/$/, "");
    const targetUrl = publicBase;

    logger.info("Opening Koprol public request form", { url: targetUrl });
    await this.driver.get(targetUrl);

    // Tunggu sampai field pencarian NIK (search_nik) muncul
    try {
      await this.driver.wait(
        until.elementLocated(
          By.css("input[name='search_nik'], #search_nik")
        ),
        15000
      );
    } catch (e) {}
  }

  async findPublicNikInput() {
    if (!this.driver) {
      await this.initialize();
    }

    // Field pencarian NIK memiliki name/id 'search_nik' sesuai inspeksi di browser
    try {
      const el = await this.driver.findElement(
        By.css("input[name='search_nik'], #search_nik")
      );
      if (el) {
        return el;
      }
    } catch (e) {}

    // Fallback: coba beberapa selector generik sambil scroll ke bawah
    const selectors = [
      "input[name*='nik']",
      "input[id*='nik']",
      "input[placeholder*='NIK']",
      "input[placeholder*='Nik']",
      "input[placeholder*='nik']",
    ];

    for (let attempt = 0; attempt < 5; attempt++) {
      for (const sel of selectors) {
        try {
          const el = await this.driver.findElement(By.css(sel));
          if (el) {
            return el;
          }
        } catch (e) {}
      }

      try {
        await this.driver.executeScript(
          "window.scrollBy(0, Math.max(400, window.innerHeight/2));"
        );
      } catch (e) {}
      await this.driver.sleep(400);
    }

    throw new Error("Field NIK pada form publik tidak ditemukan");
  }

  async findPublicLabelElement(labelCandidates = []) {
    if (!this.driver) {
      await this.initialize();
    }

    const labels = Array.isArray(labelCandidates)
      ? labelCandidates
      : [labelCandidates];

    for (const labelText of labels) {
      if (!labelText) continue;
      const lower = String(labelText).toLowerCase();
      const xp =
        "//*[self::label or self::td or self::th or self::div]" +
        "[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')," +
        this.xpathLiteral(lower) +
        ")]";
      try {
        const el = await this.driver.findElement(By.xpath(xp));
        if (el) {
          return el;
        }
      } catch (e) {}
    }

    return null;
  }

  async readPublicTextFieldByLabel(labelCandidates = []) {
    const labelEl = await this.findPublicLabelElement(labelCandidates);
    if (!labelEl) {
      return "";
    }

    // Coba cari input yang benar-benar terlihat (bukan hidden / ID internal)
    try {
      const candidates = await labelEl.findElements(
        By.xpath(".//following::input[position() <= 3]")
      );
      let chosen = null;
      for (const input of candidates) {
        try {
          const typeAttr =
            ((await input.getAttribute("type")) || "text").toLowerCase();
          if (typeAttr === "hidden") continue;
          // Hanya pilih input yang benar-benar terlihat di layar (boleh readonly)
          try {
            const visible = await input.isDisplayed();
            if (!visible) continue;
          } catch (e) {
            continue;
          }
          chosen = input;
          break;
        } catch (e) {}
      }

      if (chosen) {
        const val = ((await chosen.getAttribute("value")) || "").trim();
        if (val) {
          return val;
        }
        const txt = ((await chosen.getText()) || "").trim();
        if (txt) {
          return txt;
        }
      }
    } catch (e) {}

    // Fallback: input pertama setelah label (bisa saja ID internal)
    try {
      const input = await labelEl.findElement(By.xpath(".//following::input[1]"));
      const val = ((await input.getAttribute("value")) || "").trim();
      if (val) {
        return val;
      }
    } catch (e) {}

    // Fallback terakhir: teks di sekitar label
    try {
      const txt = ((await labelEl.getText()) || "").trim();
      if (txt) {
        return txt;
      }
    } catch (e) {}

    return "";
  }

  async readPublicDropdownOptionsByLabel(labelCandidates = []) {
    const labelEl = await this.findPublicLabelElement(labelCandidates);
    if (!labelEl) {
      return [];
    }

    const texts = [];

    // 1) Coba baca langsung dari elemen <select> (jika ada)
    let select = null;
    try {
      select = await labelEl.findElement(By.xpath(".//following::select[1]"));
    } catch (e) {}

    if (select) {
      try {
        const options = await select.findElements(By.css("option"));
        for (const opt of options) {
          try {
            const txt = ((await opt.getText()) || "").trim();
            if (txt) {
              texts.push(txt);
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    // 2) Jika belum ada hasil, coba baca dari komponen Select2 (dropdown modern)
    if (!texts.length) {
      try {
        let container = null;
        try {
          container = await labelEl.findElement(
            By.xpath(
              "./ancestor::div[contains(@class,'s_website_form_field') or contains(@class,'form-group')][1]"
            )
          );
        } catch (e) {
          container = labelEl;
        }

        let trigger = null;
        try {
          trigger = await container.findElement(
            By.css("span.select2-selection, span.select2-selection__rendered")
          );
        } catch (e) {}

        if (trigger) {
          try {
            await this.scrollIntoView(trigger).catch(() => {});
          } catch (e) {}
          try {
            await trigger.click();
            await this.driver.sleep(300);
          } catch (e) {}

          try {
            const items = await this.driver.findElements(
              By.css(".select2-results__option")
            );
            for (const li of items) {
              try {
                const txt = ((await li.getText()) || "").trim();
                if (!txt) continue;
                if (/silahkan pilih/i.test(txt)) continue;
                texts.push(txt);
              } catch (e) {}
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    const seen = new Set();
    const unique = [];
    for (const t of texts) {
      const key = t.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(t);
      }
    }
    return unique;
  }

  async readRequestKeOptions() {
    if (!this.driver) {
      await this.initialize();
    }

    const texts = [];

    // 1) Coba langsung via JS di document (lebih tahan terhadap Select2/hidden select)
    try {
      const jsTexts =
        (await this.driver.executeScript(function () {
          const sel =
            document.querySelector(
              "select[name='department_request_id'], #department_request_id"
            ) || null;
          if (!sel || !sel.options) return [];
          const out = [];
          for (let i = 0; i < sel.options.length; i++) {
            const opt = sel.options[i];
            const txt = (opt.textContent || "").trim();
            if (!txt) continue;
            if (/silahkan pilih/i.test(txt)) continue;
            out.push(txt);
          }
          return out;
        })) || [];
      if (Array.isArray(jsTexts)) {
        for (const t of jsTexts) {
          texts.push(String(t));
        }
      }
    } catch (e) {}

    // 2) Fallback: pakai WebDriver langsung pada elemen <select>
    if (!texts.length) {
      try {
        const select = await this.driver.findElement(
          By.css("select[name='department_request_id'], #department_request_id")
        );
        const options = await select.findElements(By.css("option"));
        for (const opt of options) {
          try {
            const txt = ((await opt.getText()) || "").trim();
            if (!txt) continue;
            if (/silahkan pilih/i.test(txt)) continue;
            texts.push(txt);
          } catch (e) {}
        }
      } catch (e) {}
    }

    // 2) Fallback: gunakan mekanisme umum berbasis label
    if (!texts.length) {
      try {
        const viaLabel = await this.readPublicDropdownOptionsByLabel([
          "Request ke",
          "Request Ke",
        ]);
        for (const t of viaLabel) {
          texts.push(t);
        }
      } catch (e) {}
    }

    const seen = new Set();
    const unique = [];
    for (const t of texts) {
      const key = t.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(t);
      }
    }
    return unique;
  }

  async applyPublicDropdownSelection(labelCandidates = [], value) {
    if (!value) {
      return false;
    }

    const labelEl = await this.findPublicLabelElement(labelCandidates);
    if (!labelEl) {
      return false;
    }

    let select = null;
    try {
      select = await labelEl.findElement(By.xpath(".//following::select[1]"));
    } catch (e) {}

    if (!select) {
      return false;
    }

    const targetLower = String(value).toLowerCase();
    try {
      const options = await select.findElements(By.css("option"));
      for (const opt of options) {
        let txt = "";
        try {
          txt = ((await opt.getText()) || "").trim();
        } catch (e) {}
        if (!txt) continue;
        if (txt.toLowerCase() === targetLower) {
          await this.scrollIntoView(select).catch(() => {});
          try {
            await select.click();
          } catch (e) {}
          try {
            await opt.click();
          } catch (e) {}
          await this.driver.sleep(200);
          return true;
        }
      }
    } catch (e) {}

    return false;
  }

  async inspectPublicRequestForm(nikRaw) {
    const nik = (nikRaw || "").trim();
    if (!nik) {
      throw new Error("NIK wajib diisi");
    }

    await this.openPublicTicketForm();

    const nikInput = await this.findPublicNikInput();
    await this.scrollIntoView(nikInput).catch(() => {});
    try {
      await nikInput.clear();
    } catch (e) {}
    await nikInput.sendKeys(nik);
    await this.driver.sleep(300);
    try {
      await nikInput.sendKeys(Key.ENTER);
    } catch (e) {}

    // Tunggu sampai form benar-benar mengisi nama/email setelah NIK di-enter
    let nama = "";
    let email = "";
    const startTs = Date.now();
    const timeoutMs = 7000;
    while (Date.now() - startTs < timeoutMs) {
      try {
        const namaInput = await this.driver.findElement(
          By.css("input[name='name_pegawai']")
        );
        if (await namaInput.isDisplayed()) {
          nama = ((await namaInput.getAttribute("value")) || "").trim();
        }
      } catch (e) {}

      try {
        const emailInput = await this.driver.findElement(
          By.css("input[name='email'], input[name*='email']")
        );
        if (await emailInput.isDisplayed()) {
          email = ((await emailInput.getAttribute("value")) || "").trim();
        }
      } catch (e) {}

      if (nama || email) {
        break;
      }
      await this.driver.sleep(400);
    }

    const dropdowns = {
      requestKe: (await this.readRequestKeOptions()) || [],
      tipeRequestFor:
        (await this.readPublicDropdownOptionsByLabel([
          "Tipe Request For",
          "Type Request For",
        ])) || [],
      system:
        (await this.readPublicDropdownOptionsByLabel([
          "System",
          "Sistem",
        ])) || [],
      tipeMasalah:
        (await this.readPublicDropdownOptionsByLabel([
          "Tipe Masalah",
          "Problem Type",
        ])) || [],
    };

    if (!nama && !email) {
      return {
        ok: false,
        nik,
        errorMessage:
          "NIK belum terdaftar di sistem atau form publik tidak mengembalikan data nama/email.",
      };
    }

    return {
      ok: true,
      nik,
      nama,
      email,
      dropdowns,
    };
  }

  async submitPublicRequestForm(payload = {}) {
    const data = payload || {};
    const nik = (data.nik || "").trim();
    if (!nik) {
      throw new Error("NIK wajib diisi untuk submit form publik");
    }

    await this.openPublicTicketForm();

    const nikInput = await this.findPublicNikInput();
    await this.scrollIntoView(nikInput).catch(() => {});
    try {
      await nikInput.clear();
    } catch (e) {}
    await nikInput.sendKeys(nik);
    await this.driver.sleep(300);
    try {
      await nikInput.sendKeys(Key.ENTER);
    } catch (e) {}
    await this.driver.sleep(1200);

    if (data.noHp) {
      await this.fillPublicPhoneField(data.noHp).catch(() => {});
    }

    if (data.requestKe) {
      await this.selectRequestKeOnForm(data.requestKe).catch(() => {});
    }

    if (data.tipeRequestFor) {
      await this.applyPublicDropdownSelection(
        ["Tipe Request For", "Type Request For"],
        data.tipeRequestFor
      );
    }

    if (data.system) {
      await this.applyPublicDropdownSelection(
        ["System", "Sistem"],
        data.system
      );
    }

    if (data.tipeMasalah) {
      await this.applyPublicDropdownSelection(
        ["Tipe Masalah", "Problem Type"],
        data.tipeMasalah
      );
    }

    if (data.keterangan) {
      try {
        const descLabel = await this.findPublicLabelElement([
          "Keterangan",
          "Deskripsi",
          "Description",
        ]);
        if (descLabel) {
          try {
            const ta = await descLabel.findElement(
              By.xpath(".//following::textarea[1]")
            );
            await this.scrollIntoView(ta).catch(() => {});
            try {
              await ta.click();
            } catch (e) {}
            try {
              await ta.clear();
            } catch (e) {}
            await ta.sendKeys(String(data.keterangan));
          } catch (e) {}
        }
      } catch (e) {}
    }

    let submitClicked = false;
    const submitLabels = [
      "Submit",
      "Kirim",
      "Ajukan",
    ];
    for (const label of submitLabels) {
      const upper = (label || "").toUpperCase();
      const xp =
        `//button[normalize-space(.)='${label}']` +
        ` | //button[contains(translate(normalize-space(.),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'),'${upper}')]` +
        ` | //a[normalize-space(.)='${label}']` +
        ` | //a[contains(translate(normalize-space(.),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'),'${upper}')]`;
      try {
        const btn = await this.driver.findElement(By.xpath(xp));
        await this.scrollIntoView(btn).catch(() => {});
        try {
          await btn.click();
        } catch (e) {}
        submitClicked = true;
        break;
      } catch (e) {}
    }

    if (!submitClicked) {
      throw new Error("Tombol submit pada form publik tidak ditemukan");
    }

    await this.driver.sleep(1500);

    let successMessage = "";
    try {
      const alertEl = await this.driver.findElement(
        By.css(".alert-success, .oe_website_messages, .alert")
      );
      successMessage = ((await alertEl.getText()) || "").trim();
    } catch (e) {}

    return {
      ok: true,
      nik,
      successMessage,
    };
  }

  async submitTicketRating(options = {}) {
    const { statusUrl, rating = 5, comment = "", action = "done" } =
      options || {};

    if (!statusUrl) {
      throw new Error("statusUrl wajib diisi untuk submit rating tiket");
    }

    if (!this.driver) {
      await this.initialize();
    }

    const safeRating = Math.max(
      1,
      Math.min(5, parseInt(rating, 10) || 5)
    );

    logger.info("Opening ticket status page for rating", {
      url: statusUrl,
      rating: safeRating,
      action,
    });

    await this.driver.get(statusUrl);
    await this.driver.sleep(1000);

    // Set bintang rating 1	7 di halaman status_request publik
    try {
      await this.driver.executeScript(
        "var n=arguments[0]||5;" +
          "var containers=Array.from(document.querySelectorAll('*')).filter(function(el){return /Rating Pelayanan/i.test(el.textContent||'');});" +
          "var root=containers.length?containers[0].parentElement:document;" +
          "var stars=root.querySelectorAll('.fa-star, .fa-star-o, .fa-star-half, .rating i, .rating-star, .star-rating i');" +
          "if(!stars.length){stars=document.querySelectorAll('.fa-star, .rating i, .rating-star, .star-rating i');}" +
          "for(var i=0;i<stars.length;i++){ if(i<n){stars[i].dispatchEvent(new MouseEvent('click',{bubbles:true})); } }" +
          "return stars.length;",
        safeRating
      );
    } catch (e) {
      logger.warn(
        "Failed to set rating stars on status page",
        e.message || e
      );
    }

    // Isi komentar jika ada
    if (comment) {
      try {
        const textareas = await this.driver.findElements(
          By.css(
            "textarea[placeholder*='Comment'], textarea[placeholder*='comment'], textarea"
          )
        );
        for (const ta of textareas) {
          try {
            const rect = await ta.getRect();
            if (rect.width < 2 || rect.height < 2) continue;
            await this.scrollIntoView(ta).catch(() => {});
            await ta.click().catch(() => {});
            await this.driver.sleep(100);
            try {
              await ta.clear();
            } catch (e) {}
            await ta.sendKeys(comment);
            await this.driver.sleep(150);
            break;
          } catch (e) {}
        }
      } catch (e) {
        logger.warn("Failed to fill rating comment", e.message || e);
      }
    }

    // Tekan tombol Done Ticket atau Return Ticket
    const labels =
      action === "return" ? ["Return Ticket", "Return"] : ["Done Ticket", "Done"];
    let clicked = false;

    for (const label of labels) {
      const upper = (label || "").toUpperCase();
      const xp =
        `//button[normalize-space(.)='${label}']` +
        ` | //button[contains(translate(normalize-space(.),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'),'${upper}')]` +
        ` | //a[normalize-space(.)='${label}']` +
        ` | //a[contains(translate(normalize-space(.),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'),'${upper}')]`;
      const els = await this.driver.findElements(By.xpath(xp));
      if (els.length) {
        try {
          const btn = els[0];
          await this.scrollIntoView(btn).catch(() => {});
          await btn.click();
          clicked = true;
          break;
        } catch (e) {}
      }
    }

    if (!clicked) {
      logger.warn("Rating action button not found on status page", {
        action,
      });
    }

    await this.driver.sleep(1000);

    return {
      ok: true,
      statusUrl,
      rating: safeRating,
      action,
      comment,
    };
  }

  async close() {
    if (this.driver) {
      await this.driver.quit();
      this.driver = null;
      this.isLoggedIn = false;
      logger.info("WebDriver closed");
    }
  }
}

module.exports = KoprolAutomation;
