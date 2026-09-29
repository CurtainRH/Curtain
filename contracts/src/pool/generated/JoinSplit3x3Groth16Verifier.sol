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
    uint256 constant deltax1 = 16068052099995225923193302400954321561884533738257865606491914572910343801654;
    uint256 constant deltax2 = 14530575718444484907924605864878770055442132980188813742621450240191806581144;
    uint256 constant deltay1 = 8620355702218969083693424535978595529511672835284575035000818369870641027644;
    uint256 constant deltay2 = 12079929140913916657536030003387640574959714181112222561385132822652259642350;

    
    uint256 constant IC0x = 9006922536648538910914106064793491152260967324931417987295175240168992602692;
    uint256 constant IC0y = 10217363187025204146942026961418933888693135332701284204374215125768837500515;
    
    uint256 constant IC1x = 2446541763951437515942074831813388330646821929306611368347217416748226617103;
    uint256 constant IC1y = 13073949901965542653720638648761765771813273123183861757282727290575597056510;
    
    uint256 constant IC2x = 16234053034552532351065292373812405022118738802926925910165046712796844317054;
    uint256 constant IC2y = 17095024663931759208789879390989410832347238228347732719582939452807026507259;
    
    uint256 constant IC3x = 17989122686794714931362021833834986213499902692001553531299950142699961981668;
    uint256 constant IC3y = 3673243713600504820131899631082431669589781538875058667177007085891446482003;
    
    uint256 constant IC4x = 10525158160906990378654254718180884897003066248660407800925968800151381237240;
    uint256 constant IC4y = 682562346163003720054650221222801477048085572583959148592311359368681726931;
    
    uint256 constant IC5x = 17302831477154313741177528914009375776980064376025997758172109939816683209486;
    uint256 constant IC5y = 16007032200052638320024265772020634808867429597535760408419374463653247722454;
    
    uint256 constant IC6x = 10142501250893035850792100460351065601168332696323956636545860874714827425804;
    uint256 constant IC6y = 14269059374487178044723251577706025232808566828185475885421877391298520888265;
    
    uint256 constant IC7x = 16903914962132913336228879798794154245997654449874809082046928267031747701751;
    uint256 constant IC7y = 17559435709384724979481080800949868377410910107990937360693093732025360672961;
    
    uint256 constant IC8x = 4105357760110593403068360693682139857864286005453753003227817338517034762881;
    uint256 constant IC8y = 21676185000000351750954701469811733334496103136305751794341424661382093920190;
    
    uint256 constant IC9x = 5128152249464771598615873078149050622330393819870851675662232045834523031619;
    uint256 constant IC9y = 1728343043355347352704745904415336033531680333772563491641568258772890715081;
    
    uint256 constant IC10x = 4254657213459914755837340368902003205353204510102492159268528253156178170663;
    uint256 constant IC10y = 7342678151565489800722470576885504992356155283416223283547239708094622574907;
    
    uint256 constant IC11x = 5292962942403734271937268316122417892894168382306963904537199243137743926191;
    uint256 constant IC11y = 7706439216998522373328973875352083017622178606067259281914147044052290216387;
    
    uint256 constant IC12x = 8462043260499425602813901110732103472582094140560476348337981338388914260015;
    uint256 constant IC12y = 19105004836996490230008108219765358415621724463962319176326019831798811857413;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[12] calldata _pubSignals) public view returns (bool) {
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
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
