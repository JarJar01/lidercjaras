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
- Online szobakészítés: opcionális szobajelszó, 2–8 játékos, várakozási idő, szobakereső.
- Online lobby: élő játékoslista, készen állás, Alkoholista király, kick és vezetőátadás. Ha mindenki kész, a vezető indítása automatikusan megnyitja a játéktáblát, a régi helykitöltő üzenet már nincs benne.
- Opcionális WebRTC mikrofon és webkamera, külön kapcsolóval; a kamera képe a játéktér felső kameracsíkjába kerül.
- Elkészült a 100 mezős, ház belsejét idéző, szerpentin útvonalú játéktábla. A kezdés a bejáratnál, a cél a WC-nél van. A mezők fehér, sárga vagy piros színe minden partin véletlenszerű.
- Kattintható, animált dobókocka; a bábu mezőről mezőre mozog; mezőnként 60 másodperces időkeret.
- Fehér mező: két kínos/felnőtt, de humoros kérdés közül választ az aktuális játékos, majd kijelöli a célpontot.
- Sárga mező: online módban a többi játékos szavaz a két feladat egyikére; döntetlennél véletlen választás. Helyi módban nincs szavazás, a játék választ véletlenszerűen.
- Piros mező: közös társasági feladat, 1–3 kortyot jelez a játék, de a játékos szabadon választhat alkoholmentes italt vagy passzolhat.
- Ütközésnél nincs két bábu ugyanazon a mezőn: vicces kézcsapás-animáció, hátralökés és az érintett játékos profilban rögzített büntetőhangja (ha van feltöltve).
- Átok-, pajzs- és boostkártyák: két kör kihagyása, kötelező egyes, visszalépés, nyilvános pajzs és bónusz a következő dobásra. A titkos átkok csak aktiválódásukkor derülnek ki; a pajzs és a hatos utáni védettség semlegesítheti őket.
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
