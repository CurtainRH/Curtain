// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity 0.8.26;

contract JoinSplit3x3Groth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20795459224953934783102106448420082608387164135129622007722732251725760683579;
    uint256 constant alphay  = 7858142057181239145590182775411756382129286418781276092603913632768968071483;
    uint256 constant betax1  = 100661932550428604442085675774287542675969638500510427824597785153534208542;
    uint256 constant betax2  = 21254854275528387360942998913594953300314036800177471800242605472386845837230;
    uint256 constant betay1  = 5087321408538359800246974194573793604891364142828477529783293233183020786275;
    uint256 constant betay2  = 20228133443620650965642919875720595454510237513715795510137155996338469708340;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 10795922072099482893108119879614534875471248406268093602864508493471758138792;
    uint256 constant deltax2 = 18326485434822739207267639949421091761149187156061410493110383495042024096532;
    uint256 constant deltay1 = 13191687933104285643522502083047579822755135137119898786371574142192278407849;
    uint256 constant deltay2 = 18679491509409531815573304598872305691834704024421935859912210140010970945654;

    
    uint256 constant IC0x = 899938750709373456503354623932082314390096928174775302089785627245656572026;
    uint256 constant IC0y = 9938313419637581225830209457560694052836065060095412556467232133857389224536;
    
    uint256 constant IC1x = 9261254406576318850516960537010547545762585067761035382376718481003153911857;
    uint256 constant IC1y = 9938037392618270494353358807736932641718113645984091717183675844130148270192;
    
    uint256 constant IC2x = 15492916187542263150335289277875844188318060625571223158670080659981709237220;
    uint256 constant IC2y = 8249858452380407994328269706226467691886730613068591975897146601373686005515;
    
    uint256 constant IC3x = 6796443264089858011667746279453088242431453244444366727851697176086646107570;
    uint256 constant IC3y = 20275077596668859687876256996511968436129415663676368777281275138940589665924;
    
    uint256 constant IC4x = 12587339918645963313110032022661868978568736742796599353786939933224347329055;
    uint256 constant IC4y = 3544598869950456301845678504602451977990402916425358985815532253348782962698;
    
    uint256 constant IC5x = 644100332361656828462846314053505972148659680575950982154014787307538987750;
    uint256 constant IC5y = 13629119889041013471875600731940372042243256132791179472329321518928486087995;
    
    uint256 constant IC6x = 5339660399932001315621261422576870568550663460880962882433018776510829276837;
    uint256 constant IC6y = 16666003860359928732909719195872385506360289938802186263912706617473600109909;
    
    uint256 constant IC7x = 1012975843679618805864696727065910944206186843317938772875866258926713952777;
    uint256 constant IC7y = 21830461630165124090496622381653669611186983213147433743598312684892845495248;
    
    uint256 constant IC8x = 7702925328362234645243200303044657262483805572904853209341944731481631773766;
    uint256 constant IC8y = 21853641439718566546587008161982122184948809411468157582459469600404967320131;
    
    uint256 constant IC9x = 16976372077154381212221655967238833318452850282034680882772676416354961901951;
    uint256 constant IC9y = 19441667802667159425788394087288813522655763394820594854336163530836547373565;
    
    uint256 constant IC10x = 3277616364523846946166774792841898838104085232312861910440130056306347110703;
    uint256 constant IC10y = 18701897294012504472916928773519591203594378848898318319965042690312171605772;
    
    uint256 constant IC11x = 20906427336927871478663301301471179674934535361791724120502177127012609786536;
    uint256 constant IC11y = 13725280317913782416876185332860405390677814686424860387708857640922403276525;
    
    uint256 constant IC12x = 11056240350403760091159129480062933701634098579015342156511476615493120804891;
    uint256 constant IC12y = 12275618068346975068222980613398757404835430223133082199014398772691009037360;
    
    uint256 constant IC13x = 14089488271094201746027505709946092096727274957444210828738865140832348664025;
    uint256 constant IC13y = 8755012844342300004734715339922130256088295498029520129353170438732325927308;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[13] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
