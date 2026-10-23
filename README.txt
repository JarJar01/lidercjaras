Játéktér UI-javítás (2026-10-23): a pálya képernyőre illesztett, kameracsíkja felül van, a dobás/kártyák/chat/napló alul látszik. A mezőfeladatok és a szavazás középen, animáltan felugró kártyán jelenik meg; a dobókocka több oldalon át pörög, majd a dobás eredményén áll meg. A játéktér asztali képernyőn belső görgetés nélkül rendeződik el.

Játékindítási javítás (2026-10-23): a játéktér gombjai és állapotmezői most helyesen kapcsolódnak a HTML elemekhez. Korábban egy belső névleképezési hiba miatt a játék betöltése után a lobbyban maradhatott. A javított game.js verziója cache-busting paramétert is kapott.

KIISZIK – ONLINE LOBBY ÉS JÁTÉKTÁBLA
=====================================

Ez külön projektcsomag a Kiiszik profiljával, online lobbyjával és játéktáblájával. Ne másold rá a Lidércjárás meglévő projektjére.

INDÍTÁS:
1. Csomagold ki egy külön mappába.
2. CMD-ben lépj a mappába.
3. Futtasd: npm install
4. Futtasd: npm start
5. Nyisd meg: http://localhost:3002

Ha a port foglalt:
   set PORT=3003 && npm start
   majd http://localhost:3003

MIT TUD EZ A VERZIÓ?
- Profilfolyamat: 18+ nyilatkozat, becenév, profilkép, majd opcionális büntetőhang-felvétel; a hanglépés kihagyható.
- Online szobakészítés: opcionális szobajelszó, 1–8 játékos, várakozási idő, szobakereső.
- Online lobby: élő játékoslista, készen állás, Alkoholista király, kick és vezetőátadás. Ha mindenki kész, a vezető indítása automatikusan megnyitja a játéktáblát, a régi helykitöltő üzenet már nincs benne.
- Opcionális WebRTC mikrofon és webkamera, külön kapcsolóval; a kamera képe a játéktér felső kameracsíkjába kerül.
- Elkészült a 100 mezős, ház belsejét idéző, szerpentin útvonalú játéktábla. A kezdés a bejáratnál, a cél a WC-nél van. A mezők fehér, sárga vagy piros színe minden partin véletlenszerű.
- Kattintható, animált dobókocka; a bábu mezőről mezőre mozog; mezőnként 60 másodperces időkeret.
- Fehér mező: két kínos/felnőtt, de humoros kérdés közül választ az aktuális játékos, majd kijelöli a célpontot.
- Sárga mező: online módban a többi játékos szavaz a két feladat egyikére; döntetlennél véletlen választás. Helyi módban nincs szavazás, a játék választ véletlenszerűen.
- Piros mező: közös társasági feladat; egy korty az alap-jelzés, de a játékos szabadon választhat alkoholmentes italt vagy passzolhat. Nincs kötelező gyors ivás vagy teljes pohár lehúzása.
- Ütközésnél nincs két bábu ugyanazon a mezőn: vicces kézcsapás-animáció, hátralökés és az érintett játékos profilban rögzített büntetőhangja (ha van feltöltve).
- Átok-, pajzs- és boostkártyák: két kör kihagyása, kötelező egyes, visszalépés, Kutyakapitány/Verébvezér becenév (három saját körre), ugatási átok és flamingó-póz, nyilvános pajzs és dobásbónusz. A titkos átkok csak aktiválódásukkor derülnek ki; a pajzs és a hatos utáni védettség semlegesítheti őket.
- Szünet szavazással, parti chat és eseménynapló.
- Helyi, egy készülékes mód: ugyanaz a tábla, animációk, feladatok, kártyák és ütközések, de nincs szavazás; a sárga mezőn a játék véletlenül dönt.
- A webes játék moduljai külön a public/game/ mappában találhatók (game.js, game.css, question-bank.json). A játéktábla az online szoba indulásakor automatikusan megnyílik; a kérdésbank betöltési hibája nem akadályozza az online felület megjelenését.
ZENÉK:
A public/music/zene1.mp3 és public/music/zene2.mp3 megmarad a csomagban.

HANGCHAT MEGJEGYZÉS:
A WebRTC peer-to-peer hang és kép a böngésző mikrofon-/kameraengedélyével és kompatibilis hálózati kapcsolattal működik. Ez az alapverzió STUN-t használ, saját TURN relay szerver nincs beállítva, ezért bizonyos hálózatokon nem jön létre a hang-/videókapcsolat.

SZOBÁK:
Az online szobák a szerver memóriájában élnek, tehát a szerver újraindításakor törlődnek. Tartós szobaadatbázis nincs ebben a verzióban.


HANGFELVETEL A PROFILNAL
- A felvételi lépés a becenév és a profilkép után, a lobby előtt jelenik meg, és a Kihagyás gombbal átugorható.
- A szobából kikerült a hangrögzítő blokk.
- A helyi IndexedDB-felvétel más böngészési munkamenetekben is megmarad ugyanabban a böngészőprofilban, amíg a felhasználó nem törli a webhelyadatokat vagy a felvételt.


Új játéktér-elrendezés:
- A profilképedből automatikusan kis, tömörített bábu-avatár készül. Online módban a szobában lévő többi játékos is látja.
- A kamera-sáv a képernyő tetején van, a bal oldali oldalsávból nyitható az eseménynapló és a kártyák, a chat a jobb oldalon marad.
- A dobókocka a házpálya közepén jelenik meg, leeső/pörgő animációval. A bábu lassabban, mezőről mezőre ugrik.


LEGFRISSEBB JÁTÉKTÉR-FELÜLET (2026-10-23)
- A 100 mezős pálya 16×10-es széles spirálrácsban tölti ki a játéktér teljes belső területét.
- A középső KIISZIK-felirat nagyobb és a dobópanel fölött is látható marad.
- Az online kamerák az engedélyezés sorrendjében, egységes kártyákban jelennek meg balról jobbra.


JÁTÉKTÉR FRISSÍTÉS (2026-10-23)
- A felső sávban csak a szünet és kilépés gomb marad; a brand/státusz felirat rejtve van.
- A középső táblalogó csak a KIISZIK felirat, finom lebegő/fény animációval.
- Szünet/feloldás szavazás középső igen/nem ablakkal működik; online módban szerverállapot vezérli a szavazást.
- A kameracsík nagyobb és a bábuanimáció simább, lassabb.


DOBÓKOCKA FRISSÍTÉS (2026-10-23)
- A dobópanel a pálya közepére kerül és nagyobb méretet kap.
- Dobáskor csak a kockán látható értékek pörögnek; a kocka nem zuhan be és nem forog 3D-ben.
- Az animáció a tényleges dobott értéken áll meg, majd a panel rövid késleltetéssel eltűnik, amíg ismét az adott játékos köre nem jön.


Új játékfunkciók: az egykészülékes mód egyedül is indítható, a sárga feladatok ebben a módban véletlenszerűen választódnak (szavazás nélkül), és a kérdésbank mindkét módban közös. Új kínos/abszurd kérdések, közös piros feladatok és becenév-/ugatási átkok kerültek a kérdésbankba. Alkoholos feladatnál víz, üdítő vagy passz is elfogadott; nincs időre ivás.


KÉRDÉSBANK ÉS EGYJÁTÉKOS FRISSÍTÉS (2026-10-23)
- A közös kérdésbank 59 fehér kérdést, 35 sárga kihívást, 12 piros feladatot, 6 átkot, 1 pajzsot és 3 boostot tartalmaz.
- A fehér mező abszurd, kínos, pikáns, felnőtteknek szóló humoros kérdéseket használ. Ha nincs válasz, a feladat 1 kortyos alternatívát jelez; víz, üdítő vagy passz is elfogadható.
- A sárga mezőn online a társaság szavaz, helyi módban (akár egyedül játszva is) a rendszer a közös bankból véletlenszerűen választ, szavazás nélkül.
- A helyi mód egy játékossal is elindítható; a fehér kérdésnél a játékos magának választ, a sárga feladat automatikus, a piros feladat egyjátékos jelölést kap.
- Az online becenévátoknál a többi játékos Kutyakapitány és Verébvezér között szavaz; egykészülékes módban véletlen választás történik. Az ugatási és flamingó-átok humoros, alternatívával is teljesíthető.
- A piros mező közös feladatai között vannak vicces pózok, csipogás, kínos bevallások és önkéntes külsőruha-réteg kihívás. Fehérneműre vetkőzés és az alkohol teljes lehúzása nem kötelező.
